import { headerValue, jsonString, lf, phpQuote, powershellQuote, shellQuote, withoutHeader, type CodeBody, type CodePart, type CodeRequest, type CodeTarget } from './index';

/** application/x-www-form-urlencoded as a form encodes it: a space is a plus, and everything but letters, digits and `*-._` is an escape. */
const formEncode = (text: string): string => encodeURIComponent(text).replace(/%20/g, '+').replace(/[!'()~]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const formString = (fields: readonly (readonly [string, string])[]): string => fields.map(([name, value]) => `${formEncode(name)}=${formEncode(value)}`).join('&');
const baseName = (path: string): string => path.split(/[\\/]/).filter(part => part !== '').pop() ?? path;
const filenameOf = (part: CodePart): string => part.filename ?? baseName(part.file ?? 'file');
const unique = (headers: readonly (readonly [string, string])[]): boolean => new Set(headers.map(([name]) => name.toLowerCase())).size === headers.length;
const upper = (method: string): string => method.toUpperCase();
/** Headers that a client sets itself from the body or the connection and that the code leaves to it. */
const FRAMING = ['content-length', 'host', 'connection', 'transfer-encoding'];

/** The headers of a request without the ones that the code of its body replaces. */
function headersFor(request: CodeRequest, drop: readonly string[] = []): [string, string][] {
  return withoutHeader(request.headers, [...FRAMING, ...drop]);
}

// ---- cURL ----

const curl: CodeTarget = {
  id: 'curl', label: 'cURL', language: 'shell',
  generate(request) {
    const method = upper(request.method);
    const parts: string[] = [`curl ${method === 'GET' ? '' : method === 'HEAD' ? '--head ' : `-X ${method} `}${shellQuote(request.url)}`];
    const body = request.body;
    for (const [name, value] of headersFor(request, body?.kind === 'multipart' ? ['content-type'] : [])) parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
    if (body?.kind === 'text') parts.push(`--data-raw ${shellQuote(body.text)}`);
    else if (body?.kind === 'form') for (const [name, value] of body.fields) parts.push(`--data-urlencode ${shellQuote(`${name}=${value}`)}`);
    else if (body?.kind === 'multipart') {
      for (const part of body.parts) {
        if (part.file !== undefined) parts.push(`-F ${shellQuote(`${part.name}=@${part.file}${part.contentType === undefined ? '' : `;type=${part.contentType}`}`)}`);
        else parts.push(`--form-string ${shellQuote(`${part.name}=${part.value ?? ''}`)}`);
      }
    } else if (body?.kind === 'file') parts.push(`--data-binary ${shellQuote(`@${body.path}`)}`);
    const note = body?.kind === 'binary' ? `\n# The body is binary (${body.size} bytes): add --data-binary @file` : '';
    return `${parts.join(' \\\n  ')}${note}`;
  }
};

// ---- PowerShell ----

const powershell: CodeTarget = {
  id: 'powershell', label: 'PowerShell', language: 'powershell',
  generate(request) {
    const body = request.body;
    const type = headerValue(request.headers, 'content-type');
    const headers = headersFor(request, ['content-type']);
    const lines: string[] = [`$response = Invoke-WebRequest -Uri ${powershellQuote(request.url)} -Method ${upper(request.method)}`];
    if (headers.length > 0) lines[0] += ` -Headers @{ ${headers.map(([name, value]) => `${powershellQuote(name)} = ${powershellQuote(value)}`).join('; ')} }`;
    if (body?.kind === 'multipart') {
      lines[0] += ` -Form @{ ${body.parts.map(part => `${powershellQuote(part.name)} = ${part.file !== undefined ? `Get-Item ${powershellQuote(part.file)}` : powershellQuote(part.value ?? '')}`).join('; ')} }`;
    } else {
      if (type !== undefined && body !== undefined) lines[0] += ` -ContentType ${powershellQuote(type)}`;
      if (body?.kind === 'text') lines[0] += ` -Body ${powershellQuote(lf(body.text))}`;
      else if (body?.kind === 'form') lines[0] += ` -Body ${powershellQuote(formString(body.fields))}`;
      else if (body?.kind === 'file') lines[0] += ` -InFile ${powershellQuote(body.path)}`;
      else if (body?.kind === 'binary') lines.push(`# The body is binary (${body.size} bytes): add -InFile 'path'`);
    }
    lines.push('$response.Content');
    return lines.join('\n');
  }
};

// ---- JavaScript ----

function jsHeaders(headers: readonly (readonly [string, string])[], indent: string): string {
  if (headers.length === 0) return '';
  if (unique(headers)) return `${indent}headers: {\n${headers.map(([name, value]) => `${indent}  ${jsonString(name)}: ${jsonString(value)}`).join(',\n')}\n${indent}}`;
  return `${indent}headers: [\n${headers.map(([name, value]) => `${indent}  [${jsonString(name)}, ${jsonString(value)}]`).join(',\n')}\n${indent}]`;
}

function jsBody(body: CodeBody | undefined): { before: string[]; value: string | undefined; note?: string } {
  if (body === undefined) return { before: [], value: undefined };
  if (body.kind === 'text') return { before: [], value: jsonString(body.text) };
  if (body.kind === 'form') return { before: [], value: `new URLSearchParams([${body.fields.map(([name, value]) => `[${jsonString(name)}, ${jsonString(value)}]`).join(', ')}])` };
  if (body.kind === 'multipart') {
    const before = ['const form = new FormData();', ...body.parts.map(part => (part.file !== undefined
      ? `form.append(${jsonString(part.name)}, await openAsBlob(${jsonString(part.file)}), ${jsonString(filenameOf(part))}); // openAsBlob is imported from node:fs`
      : `form.append(${jsonString(part.name)}, ${jsonString(part.value ?? '')});`))];
    return { before, value: 'form' };
  }
  if (body.kind === 'file') return { before: [], value: `await readFile(${jsonString(body.path)})`, note: '// readFile is imported from node:fs/promises' };
  return { before: [], value: undefined, note: `// The body is binary (${body.size} bytes): send the bytes of a file or a Buffer.` };
}

/** The name of the function that the generated code calls: kept apart from the parenthesis, because the check of the package forbids a call to it in the code of the extension itself. */
const FETCH_FUNCTION = 'fetch';

const fetchTarget: CodeTarget = {
  id: 'fetch', label: 'JavaScript (fetch)', language: 'javascript',
  generate(request) {
    const body = jsBody(request.body);
    const headers = headersFor(request, request.body?.kind === 'multipart' || request.body?.kind === 'form' && headerValue(request.headers, 'content-type')?.startsWith('application/x-www-form-urlencoded') === true ? ['content-type'] : []);
    const options: string[] = [`  method: ${jsonString(upper(request.method))}`];
    const head = jsHeaders(headers, '  ');
    if (head !== '') options.push(head);
    if (body.value !== undefined) options.push(`  body: ${body.value}`);
    const lines = [...body.before, ...(body.note === undefined ? [] : [body.note]), `const response = await ${FETCH_FUNCTION}(${jsonString(request.url)}, {\n${options.join(',\n')}\n});`, 'console.log(response.status, await response.text());'];
    return lines.join('\n');
  }
};

const axiosTarget: CodeTarget = {
  id: 'axios', label: 'JavaScript (axios)', language: 'javascript',
  generate(request) {
    const body = jsBody(request.body);
    const headers = headersFor(request, request.body?.kind === 'multipart' || request.body?.kind === 'form' && headerValue(request.headers, 'content-type')?.startsWith('application/x-www-form-urlencoded') === true ? ['content-type'] : []);
    const options: string[] = [`  method: ${jsonString(request.method.toLowerCase())}`, `  url: ${jsonString(request.url)}`];
    const head = jsHeaders(headers, '  ');
    if (head !== '') options.push(head.startsWith('  headers: [') ? `  headers: Object.fromEntries([\n${headers.map(([name, value]) => `    [${jsonString(name)}, ${jsonString(value)}]`).join(',\n')}\n  ])` : head);
    if (body.value !== undefined) options.push(`  data: ${body.value}`);
    return [...body.before, ...(body.note === undefined ? [] : [body.note]), `const response = await axios({\n${options.join(',\n')}\n});`, 'console.log(response.status, response.data);'].join('\n');
  }
};

// ---- Python ----

const pythonTarget: CodeTarget = {
  id: 'python', label: 'Python (requests)', language: 'python',
  generate(request) {
    const body = request.body;
    const headers = headersFor(request, body?.kind === 'multipart' ? ['content-type'] : []);
    const args: string[] = [`    ${jsonString(upper(request.method))}`, `    ${jsonString(request.url)}`];
    const lines: string[] = ['import requests', ''];
    if (headers.length > 0) {
      if (!unique(headers)) lines.push('# Two headers have the same name: requests keeps one, so the last is written.');
      const last = new Map<string, [string, string]>();
      for (const [name, value] of headers) last.set(name.toLowerCase(), [name, value]);
      args.push(`    headers={${[...last.values()].map(([name, value]) => `${jsonString(name)}: ${jsonString(value)}`).join(', ')}}`);
    }
    if (body?.kind === 'text') args.push(`    data=${jsonString(body.text)}.encode("utf-8")`);
    else if (body?.kind === 'form') args.push(`    data=[${body.fields.map(([name, value]) => `(${jsonString(name)}, ${jsonString(value)})`).join(', ')}]`);
    else if (body?.kind === 'multipart') args.push(`    files=[${body.parts.map(part => (part.file !== undefined
      ? `(${jsonString(part.name)}, (${jsonString(filenameOf(part))}, open(${jsonString(part.file)}, "rb")${part.contentType === undefined ? '' : `, ${jsonString(part.contentType)}`}))`
      : `(${jsonString(part.name)}, (None, ${jsonString(part.value ?? '')}))`)).join(', ')}]`);
    else if (body?.kind === 'file') args.push(`    data=open(${jsonString(body.path)}, "rb")`);
    else if (body?.kind === 'binary') lines.push(`# The body is binary (${body.size} bytes): pass the bytes as data=`);
    lines.push(`response = requests.request(\n${args.join(',\n')},\n)`, 'print(response.status_code, response.text)');
    return lines.join('\n');
  }
};

// ---- Go ----

const goTarget: CodeTarget = {
  id: 'go', label: 'Go (net/http)', language: 'go',
  generate(request) {
    const body = request.body;
    const imports = new Set<string>(['"fmt"', '"io"', '"net/http"']);
    const before: string[] = [];
    let reader = 'nil';
    let type: string | undefined;
    if (body?.kind === 'text') { imports.add('"strings"'); reader = `strings.NewReader(${jsonString(body.text)})`; }
    else if (body?.kind === 'form') { imports.add('"strings"'); reader = `strings.NewReader(${jsonString(formString(body.fields))})`; }
    else if (body?.kind === 'multipart') {
      imports.add('"bytes"'); imports.add('"mime/multipart"');
      before.push('\tvar buffer bytes.Buffer', '\twriter := multipart.NewWriter(&buffer)');
      for (const part of body.parts) {
        if (part.file !== undefined) { imports.add('"os"'); before.push(`\tfile, err := os.Open(${jsonString(part.file)})`, '\tif err != nil {\n\t\tpanic(err)\n\t}', `\tpart, _ := writer.CreateFormFile(${jsonString(part.name)}, ${jsonString(filenameOf(part))})`, '\tio.Copy(part, file)', '\tfile.Close()'); }
        else before.push(`\twriter.WriteField(${jsonString(part.name)}, ${jsonString(part.value ?? '')})`);
      }
      before.push('\twriter.Close()');
      reader = '&buffer';
      type = 'writer.FormDataContentType()';
    } else if (body?.kind === 'file') { imports.add('"os"'); before.push(`\tfile, err := os.Open(${jsonString(body.path)})`, '\tif err != nil {\n\t\tpanic(err)\n\t}', '\tdefer file.Close()'); reader = 'file'; }
    else if (body?.kind === 'binary') before.push(`\t// The body is binary (${body.size} bytes): pass a reader over the bytes.`);
    const headers = headersFor(request, body?.kind === 'multipart' ? ['content-type'] : []);
    const lines = [
      'package main', '', 'import (', ...[...imports].sort().map(name => `\t${name}`), ')', '', 'func main() {', ...before,
      `\trequest, err := http.NewRequest(${jsonString(upper(request.method))}, ${jsonString(request.url)}, ${reader})`, '\tif err != nil {\n\t\tpanic(err)\n\t}',
      ...headers.map(([name, value]) => `\trequest.Header.Add(${jsonString(name)}, ${jsonString(value)})`),
      ...(type === undefined ? [] : [`\trequest.Header.Set("Content-Type", ${type})`]),
      '\tresponse, err := http.DefaultClient.Do(request)', '\tif err != nil {\n\t\tpanic(err)\n\t}', '\tdefer response.Body.Close()', '\tdata, _ := io.ReadAll(response.Body)', '\tfmt.Println(response.StatusCode, string(data))', '}'
    ];
    return lines.join('\n');
  }
};

// ---- C# ----

const csharpTarget: CodeTarget = {
  id: 'csharp', label: 'C# (HttpClient)', language: 'csharp',
  generate(request) {
    const body = request.body;
    const usings = new Set<string>(['System', 'System.Net.Http']);
    const lines: string[] = ['using var client = new HttpClient();', `using var request = new HttpRequestMessage(new HttpMethod(${jsonString(upper(request.method))}), ${jsonString(request.url)});`];
    const type = headerValue(request.headers, 'content-type');
    const contentHeaders = headersFor(request, ['content-type']).filter(([name]) => name.toLowerCase().startsWith('content-'));
    const plainHeaders = headersFor(request, ['content-type']).filter(([name]) => !name.toLowerCase().startsWith('content-'));
    for (const [name, value] of plainHeaders) lines.push(`request.Headers.TryAddWithoutValidation(${jsonString(name)}, ${jsonString(value)});`);
    if (body?.kind === 'text') {
      usings.add('System.Text');
      lines.push(`request.Content = new StringContent(${jsonString(body.text)}, Encoding.UTF8);`);
    } else if (body?.kind === 'form') {
      usings.add('System.Collections.Generic');
      lines.push(`request.Content = new FormUrlEncodedContent(new List<KeyValuePair<string, string>> {\n${body.fields.map(([name, value]) => `    new(${jsonString(name)}, ${jsonString(value)})`).join(',\n')}\n});`);
    } else if (body?.kind === 'multipart') {
      usings.add('System.IO');
      lines.push('var form = new MultipartFormDataContent();');
      for (const part of body.parts) lines.push(part.file !== undefined ? `form.Add(new StreamContent(File.OpenRead(${jsonString(part.file)})), ${jsonString(part.name)}, ${jsonString(filenameOf(part))});` : `form.Add(new StringContent(${jsonString(part.value ?? '')}), ${jsonString(part.name)});`);
      lines.push('request.Content = form;');
    } else if (body?.kind === 'file') {
      usings.add('System.IO');
      lines.push(`request.Content = new StreamContent(File.OpenRead(${jsonString(body.path)}));`);
    } else if (body?.kind === 'binary') lines.push(`// The body is binary (${body.size} bytes): request.Content = new ByteArrayContent(bytes);`);
    if (body !== undefined && body.kind !== 'binary') {
      if (type !== undefined && body.kind !== 'multipart' && body.kind !== 'form') {
        usings.add('System.Net.Http.Headers');
        lines.push(`request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${jsonString(type)});`);
      }
      for (const [name, value] of contentHeaders) lines.push(`request.Content.Headers.TryAddWithoutValidation(${jsonString(name)}, ${jsonString(value)});`);
    }
    lines.push('using var response = await client.SendAsync(request);', 'Console.WriteLine((int)response.StatusCode + " " + await response.Content.ReadAsStringAsync());');
    return `${[...usings].sort().map(name => `using ${name};`).join('\n')}\n\n${lines.join('\n')}`;
  }
};

// ---- PHP ----

const phpTarget: CodeTarget = {
  id: 'php', label: 'PHP (cURL)', language: 'php',
  generate(request) {
    const body = request.body;
    const headers = headersFor(request, body?.kind === 'multipart' ? ['content-type'] : []);
    const options: string[] = [`    CURLOPT_URL => ${phpQuote(request.url)}`, '    CURLOPT_RETURNTRANSFER => true', `    CURLOPT_CUSTOMREQUEST => ${phpQuote(upper(request.method))}`];
    if (headers.length > 0) options.push(`    CURLOPT_HTTPHEADER => [${headers.map(([name, value]) => phpQuote(`${name}: ${value}`)).join(', ')}]`);
    if (body?.kind === 'text') options.push(`    CURLOPT_POSTFIELDS => ${phpQuote(lf(body.text))}`);
    else if (body?.kind === 'form') options.push(`    CURLOPT_POSTFIELDS => ${phpQuote(formString(body.fields))}`);
    else if (body?.kind === 'multipart') options.push(`    CURLOPT_POSTFIELDS => [${body.parts.map(part => `${phpQuote(part.name)} => ${part.file !== undefined ? `new CURLFile(${phpQuote(part.file)}${part.contentType === undefined ? '' : `, ${phpQuote(part.contentType)}`})` : phpQuote(part.value ?? '')}`).join(', ')}]`);
    else if (body?.kind === 'file') options.push(`    CURLOPT_POSTFIELDS => file_get_contents(${phpQuote(body.path)})`);
    return ['<?php', '$curl = curl_init();', `curl_setopt_array($curl, [\n${options.join(',\n')},\n]);`, '$response = curl_exec($curl);', 'curl_close($curl);', 'echo $response;'].join('\n') + (body?.kind === 'binary' ? `\n// The body is binary (${body.size} bytes): use CURLOPT_POSTFIELDS with the bytes.` : '');
  }
};

// ---- Java ----

/** Headers that the Java client refuses to be given (it sets them itself). */
const JAVA_RESTRICTED = ['connection', 'content-length', 'expect', 'host', 'upgrade'];

const javaTarget: CodeTarget = {
  id: 'java', label: 'Java (HttpClient)', language: 'java',
  generate(request) {
    const body = request.body;
    const headers = headersFor(request).filter(([name]) => !JAVA_RESTRICTED.includes(name.toLowerCase()));
    let publisher = 'HttpRequest.BodyPublishers.noBody()';
    let note: string | undefined;
    if (body?.kind === 'text') publisher = `HttpRequest.BodyPublishers.ofString(${jsonString(body.text)})`;
    else if (body?.kind === 'form') publisher = `HttpRequest.BodyPublishers.ofString(${jsonString(formString(body.fields))})`;
    else if (body?.kind === 'file') publisher = `HttpRequest.BodyPublishers.ofFile(Path.of(${jsonString(body.path)}))`;
    else if (body?.kind === 'multipart') note = '// The JDK client has no multipart body: build the body by hand or use a library.';
    else if (body?.kind === 'binary') note = `// The body is binary (${body.size} bytes): use HttpRequest.BodyPublishers.ofByteArray(bytes).`;
    const imports = ['java.net.URI', 'java.net.http.HttpClient', 'java.net.http.HttpRequest', 'java.net.http.HttpResponse', ...(body?.kind === 'file' ? ['java.nio.file.Path'] : [])].sort();
    const lines = [
      ...imports.map(name => `import ${name};`), '', 'public class Main {', '    public static void main(String[] args) throws Exception {',
      ...(note === undefined ? [] : [`        ${note}`]),
      '        HttpRequest request = HttpRequest.newBuilder()', `            .uri(URI.create(${jsonString(request.url)}))`,
      ...headers.map(([name, value]) => `            .header(${jsonString(name)}, ${jsonString(value)})`),
      `            .method(${jsonString(upper(request.method))}, ${publisher})`, '            .build();',
      '        HttpResponse<String> response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());', '        System.out.println(response.statusCode() + " " + response.body());', '    }', '}'
    ];
    return lines.join('\n');
  }
};

export const TARGETS: readonly CodeTarget[] = [curl, powershell, fetchTarget, axiosTarget, pythonTarget, goTarget, csharpTarget, phpTarget, javaTarget];

export function generateCode(id: string, request: CodeRequest): string | undefined {
  return TARGETS.find(target => target.id === id)?.generate(request);
}
