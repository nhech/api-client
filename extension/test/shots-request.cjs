'use strict';
/*
 * Runs inside the VS Code extension host for extension/test/screenshots.cjs (SHOTS_SCENARIO=request): makes a small collection that is
 * served by a server in this process, opens a request, sends it, and asks the other side for a picture at each state (a request file,
 * answered by a done file).
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vscode = require('vscode');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exchange = process.env.SHOTS_EXCHANGE;

async function shot(name, width, height, settle, script) {
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('notifications.hideToasts');
  fs.writeFileSync(path.join(exchange, `${name}.request`), JSON.stringify({ name, width, height, settle, script }));
  const done = path.join(exchange, `${name}.done`);
  for (let waited = 0; !fs.existsSync(done) && waited < 60000; waited += 100) await sleep(100);
  if (!fs.existsSync(done)) throw new Error(`The picture ${name} was not taken.`);
}

const PETS = [
  { id: 1, name: 'Rex', tag: 'dog', status: 'available', born: '2021-03-14', weightKg: 31.5 },
  { id: 2, name: 'Mittens', tag: 'cat', status: 'pending', born: '2022-07-02', weightKg: 4.2 },
  { id: 3, name: 'Goldie', tag: 'fish', status: 'available', born: '2023-01-20', weightKg: 0.1 },
  { id: 4, name: 'Polly', tag: 'bird', status: 'sold', born: '2020-11-05', weightKg: 0.4 }
];

exports.run = async function run() {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await sleep(2500);
  const extension = vscode.extensions.getExtension('longtd.api-client');
  const test = await extension.activate();

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Set-Cookie', ['session=9f2c1a77b3; Path=/; HttpOnly; SameSite=Lax', 'theme=dark; Path=/; Max-Age=86400']);
      res.setHeader('X-Request-Id', 'req_8c71d0e2');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ pets: PETS, total: PETS.length, next: null }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const put = (relative, content) => {
      const target = path.join(workspace, ...relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };
    put('api-client/collections/pet-store/collection.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1AAA\nname: Pet Store\nbaseUrl: "{{baseUrl}}"\nauth:\n  kind: bearer\n  token: "{{token}}"\n');
    put('api-client/collections/pet-store/pets/folder.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1AAB\nname: Pets\n');
    put('api-client/collections/pet-store/pets/list-pets.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ABC\nname: List pets\nmethod: GET\nurl: /pets\nquery:\n  - name: limit\n    value: 10\n  - name: status\n    value: available\n    enabled: false\nheaders:\n  - name: Accept\n    value: application/json\ntests:\n  - expr: status == 200\n  - expr: json $.total == 4\n  - expr: json $.pets count >= 1\n  - expr: header content-type includes json\n  - expr: duration < 1\n  - expr: json $.next exists\n  - expr: body hasStuff\ncaptures:\n  - expr: petId = json $.pets[0].id\n  - expr: access_token = json $.pets[0].name\n  - expr: missing = json $.nothing\n');
    put('api-client/collections/pet-store/pets/create-pet.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ABD\nname: Create pet\nmethod: POST\nurl: /pets\nbody:\n  kind: json\n  text: |-\n    {\n      "name": "Rex",\n      "tag": "dog"\n    }\n');
    put('api-client/collections/pet-store/pets/get-pet.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ABE\nname: Get a pet\nmethod: GET\nurl: "{{baseUrl}}/pets/{petId}?key={{apiKey}}&request={{$guid}}"\npathParams:\n  - name: petId\n    value: 1\n');
    put('api-client/collections/pet-store/health.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ABF\nname: Health check\nurl: http://127.0.0.1:1/health\n');
    put('api-client/environments/local.env.yml', `schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1AAC\nname: Local\nvars:\n  - name: baseUrl\n    value: ${base}\n  - name: token\n    value: ""\n    secret: true\n  - name: region\n    value: eu-west\n  - name: debug\n    value: true\n    enabled: false\n`);
    put('api-client/environments/local.env.local.yml', 'schema: 1\nvalues:\n  token: demo-token-0000\n');
    for (let waited = 0; waited < 10000; waited += 100) {
      const loaded = test.client().workspace.loaded;
      if (loaded && loaded.collections.length === 1 && loaded.environments.length === 1 && loaded.environments[0].environment.vars[0].value === base) break;
      await sleep(100);
    }
    await test.client().workspace.setActiveEnvironment('01J9Z4V0N2XK7Q3M8T5R6Y1AAC');
    await vscode.commands.executeCommand('workbench.view.extension.apiClient');
    await vscode.commands.executeCommand('workbench.action.closePanel');

    const open = async name => {
      const uri = vscode.Uri.file(path.join(workspace, 'api-client', 'collections', 'pet-store', ...name.split('/')));
      await vscode.commands.executeCommand('vscode.openWith', uri, 'apiClient.request');
      for (let waited = 0; !(test.requestEditor(uri.toString())?.isReady) && waited < 15000; waited += 100) await sleep(100);
      return test.requestEditor(uri.toString());
    };
    const answer = async (view, type) => { for (let waited = 0; !view.messages().some(message => message.type === type) && waited < 15000; waited += 100) await sleep(100); await sleep(500); };

    // The answer beside the request on a wide editor, with the side bar showing the collection.
    const list = await open('pets/list-pets.req.yml');
    await sleep(800);
    await shot('request-before', 1400, 860);
    await list.receive({ type: 'send' });
    await answer(list, 'response');
    await shot('request-answer', 1400, 860, 1200);

    // The tests and the captures: the results beside the request, and the lines that make them.
    const clickTab = (label, last) => `d => { const tabs = [...d.querySelectorAll('[role=tab]')].filter(tab => tab.textContent.startsWith('${label}')); const tab = tabs[${last ? 'tabs.length - 1' : '0'}]; if (tab) { tab.click(); return 'clicked'; } return 'none'; }`;
    await shot('response-tests', 1400, 860, 1200, clickTab('Tests', true));
    await shot('request-tests', 1400, 860, 1200, clickTab('Tests', false));

    // The same on a narrow editor: the answer goes below the request.
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await sleep(500);
    await shot('request-narrow', 700, 960, 1200);

    // A request that cannot be sent says why.
    const health = await open('health.req.yml');
    await health.receive({ type: 'send' });
    await answer(health, 'failed');
    await shot('request-failed', 1000, 560, 1200);

    // The environment and the settings of the collection, each in its own editor.
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path.join(workspace, 'api-client', 'environments', 'local.env.yml')), 'apiClient.environment');
    await sleep(1500);
    await shot('environment', 1000, 520, 1200);
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path.join(workspace, 'api-client', 'collections', 'pet-store', 'collection.yml')), 'apiClient.container');
    await sleep(1500);
    await shot('collection', 1000, 520, 1200);

    // The names in the address: known (green), dynamic (blue) and not defined anywhere (red).
    await open('pets/get-pet.req.yml');
    await sleep(800);
    await shot('request-variables', 1000, 420, 1200);

    // Scripts: the tab where they are written, what they wrote to the console and tested, and a script that stops the request.
    test.scripts.answer = async () => 'allow';
    put('api-client/collections/pet-store/pets/scripted.req.yml', [
      'schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1ABG', 'name: List with scripts', 'url: /pets', 'query:', '  - name: limit', '    value: 10',
      'scripts:',
      '  pre: |',
      "    // Ask for the same page again, and say who is asking.",
      "    pm.environment.set('requestedAt', new Date().toISOString());",
      "    pm.request.headers.add({ key: 'X-Requested-At', value: pm.environment.get('requestedAt') });",
      "    console.log('sending', pm.request.method, pm.request.url.toString());",
      '  post: |',
      "    const body = pm.response.json();",
      "    pm.test('answers 200', () => pm.expect(pm.response.code).to.equal(200));",
      "    pm.test('has four pets', () => pm.expect(body.pets).to.have.length(4));",
      "    pm.test('first pet is a cat', () => pm.expect(body.pets[0].tag).to.equal('cat'));",
      "    pm.environment.set('firstPet', body.pets[0].name);",
      "    console.warn('the first pet is', body.pets[0].name);",
      ''
    ].join('\n'));
    put('api-client/collections/pet-store/pets/broken.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ABH\nname: Script that fails\nurl: /pets\nscripts:\n  pre: |\n    console.log("about to fail");\n    pm.environment.get("missing").toUpperCase();\n');
    for (let waited = 0; waited < 10000; waited += 100) {
      const pets = test.client().collections[0]?.children.find(node => node.label === 'Pets');
      if (pets && pets.children.some(node => node.label === 'List with scripts') && pets.children.some(node => node.label === 'Script that fails')) break;
      await sleep(100);
    }
    await vscode.commands.executeCommand('workbench.view.extension.apiClient');
    const scripted = await open('pets/scripted.req.yml');
    await sleep(800);
    await shot('request-scripts', 1400, 860, 1200, clickTab('Scripts', false));
    await scripted.receive({ type: 'send' });
    await answer(scripted, 'response');
    await shot('response-console', 1400, 860, 1200, clickTab('Console', true));
    await shot('response-script-tests', 1400, 860, 1200, clickTab('Tests', true));
    const broken = await open('pets/broken.req.yml');
    await broken.receive({ type: 'send' });
    await answer(broken, 'failed');
    await shot('request-script-failed', 1000, 600, 1200);
    // OAuth 2.0: the settings of the authentication and whether the request has an access token.
    put('api-client/collections/pet-store/pets/oauth.req.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1ABJ', 'name: List with OAuth', 'url: /pets', 'auth:', '  kind: oauth2', '  grant: client_credentials', '  pkce: false', '  tokenUrl: https://auth.example.com/oauth/token', '  clientId: pet-store-client', '  clientSecret: "{{clientSecret}}"', '  scope: pets.read', ''].join('\n'));
    for (let waited = 0; waited < 10000; waited += 100) {
      const pets = test.client().collections[0]?.children.find(node => node.label === 'Pets');
      if (pets && pets.children.some(node => node.label === 'List with OAuth')) break;
      await sleep(100);
    }
    await open('pets/oauth.req.yml');
    await sleep(800);
    await shot('request-oauth', 1400, 860, 1200, clickTab('Auth', false));
  } finally {
    server.closeAllConnections();
    server.close();
  }
};
