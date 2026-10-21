import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childSlugs, findChild, findEnvironment, findParent, orderAfter, planDrop, type DropResult } from '../../src/storage/organise';
import { newEnvironment } from '../../src/core/model';
import { emptyLoaded, environmentNode, shopAndBlog } from '../support/loaded';

const SHOP = 'api-client/collections/shop';
const ORDERS = `${SHOP}/orders`;

test('An entry is found by its path, with the folder that holds it', () => {
  const loaded = shopAndBlog();
  assert.equal(findChild(loaded, `${ORDERS}/archive/old.req.yml`)?.kind, 'request');
  assert.equal(findChild(loaded, ORDERS)?.kind, 'folder');
  assert.equal(findChild(loaded, SHOP)?.kind, 'collection');
  assert.equal(findChild(loaded, `${SHOP}/nothing.req.yml`), undefined);
  assert.equal(findChild(loaded, ''), undefined);
  assert.equal(findParent(loaded, `${ORDERS}/archive/old.req.yml`)?.path, `${ORDERS}/archive`);
  assert.equal(findParent(loaded, ORDERS)?.path, SHOP);
  assert.equal(findParent(loaded, SHOP), undefined, 'a collection is held by none');
  assert.equal(findParent(loaded, 'nothing'), undefined);
  assert.deepEqual(childSlugs(findChild(loaded, SHOP) as never), ['orders', 'health', 'ping']);
  const environment = environmentNode(newEnvironment('E1', 'dev'));
  assert.equal(findEnvironment(emptyLoaded([], [environment]), environment.path), environment);
  assert.equal(findEnvironment(emptyLoaded([], [environment]), 'nothing'), undefined);
});

const plan = (result: DropResult): { nodes: string[]; toDir: string; beforeSlug: string | undefined } => {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return { nodes: result.plan.nodes.map(node => node.path), toDir: result.plan.toDir, beforeSlug: result.plan.beforeSlug };
};
const refused = (result: DropResult): string => {
  assert.equal(result.ok, false);
  return result.ok ? '' : result.reason;
};

test('Dropping on a folder or a collection moves into it, at the end; dropping on a request moves next to it, before it', () => {
  const loaded = shopAndBlog();
  assert.deepEqual(plan(planDrop(loaded, [`${SHOP}/health.req.yml`], ORDERS)), { nodes: [`${SHOP}/health.req.yml`], toDir: ORDERS, beforeSlug: undefined });
  assert.deepEqual(plan(planDrop(loaded, [`${SHOP}/health.req.yml`], 'api-client/collections/blog')), { nodes: [`${SHOP}/health.req.yml`], toDir: 'api-client/collections/blog', beforeSlug: undefined });
  assert.deepEqual(plan(planDrop(loaded, [`${SHOP}/health.req.yml`], `${ORDERS}/get-order.req.yml`)), { nodes: [`${SHOP}/health.req.yml`], toDir: ORDERS, beforeSlug: 'get-order' });
  assert.deepEqual(plan(planDrop(loaded, [`${SHOP}/ping.req.yml`, `${SHOP}/health.req.yml`], ORDERS)).nodes, [`${SHOP}/ping.req.yml`, `${SHOP}/health.req.yml`], 'in the order they were dragged');
  assert.deepEqual(plan(planDrop(loaded, [`${ORDERS}/archive`], SHOP)), { nodes: [`${ORDERS}/archive`], toDir: SHOP, beforeSlug: undefined }, 'a folder can go up a level');
});

test('A drop that makes no sense is refused with a reason, and one that changes nothing is refused without one', () => {
  const loaded = shopAndBlog();
  assert.match(refused(planDrop(loaded, [`${SHOP}/health.req.yml`], undefined)), /Drop on a folder/);
  assert.match(refused(planDrop(loaded, [`${SHOP}/health.req.yml`], 'api-client/collections/nothing')), /not a place/);
  assert.match(refused(planDrop(loaded, [SHOP], 'api-client/collections/blog')), /collection cannot be moved/);
  assert.match(refused(planDrop(loaded, [ORDERS], `${ORDERS}/archive`)), /into itself/, 'into its own subfolder');
  assert.match(refused(planDrop(loaded, [ORDERS], ORDERS)), /into itself/);
  assert.match(refused(planDrop(loaded, [ORDERS], `${ORDERS}/archive/old.req.yml`)), /into itself/, 'next to a request inside it');
  assert.equal(refused(planDrop(loaded, [`${SHOP}/health.req.yml`], `${SHOP}/health.req.yml`)), '', 'on itself');
  assert.equal(refused(planDrop(loaded, [`${SHOP}/health.req.yml`, `${SHOP}/ping.req.yml`], `${SHOP}/ping.req.yml`)), '', 'on one of the things moved');
  assert.equal(refused(planDrop(loaded, ['api-client/collections/shop/gone.req.yml'], ORDERS)), '', 'what is not there');
  assert.equal(refused(planDrop(loaded, [], ORDERS)), '');
});

test('A folder dragged along with something inside it carries it, and a path named twice is moved once', () => {
  const loaded = shopAndBlog();
  assert.deepEqual(plan(planDrop(loaded, [`${ORDERS}/archive/old.req.yml`, `${ORDERS}/archive`, `${ORDERS}/archive`], 'api-client/collections/blog')).nodes, [`${ORDERS}/archive`]);
  assert.deepEqual(plan(planDrop(loaded, [`${ORDERS}/get-order.req.yml`, `${ORDERS}/get-order.req.yml`], 'api-client/collections/blog')).nodes, [`${ORDERS}/get-order.req.yml`]);
  assert.deepEqual(plan(planDrop(loaded, [`${SHOP}/health.req.yml`, `${ORDERS}/archive/old.req.yml`], 'api-client/collections/blog')).nodes, [`${SHOP}/health.req.yml`, `${ORDERS}/archive/old.req.yml`], 'a request does not hide the request next to a folder');
});

test('The new order puts the moved entries before the one they were dropped on, or at the end', () => {
  assert.deepEqual(orderAfter(['a', 'b', 'c'], ['x'], undefined), ['a', 'b', 'c', 'x']);
  assert.deepEqual(orderAfter(['a', 'b', 'c'], ['x'], 'b'), ['a', 'x', 'b', 'c']);
  assert.deepEqual(orderAfter(['a', 'b', 'c'], ['x', 'y'], 'a'), ['x', 'y', 'a', 'b', 'c']);
  assert.deepEqual(orderAfter(['a', 'b', 'c'], ['c'], 'a'), ['c', 'a', 'b'], 'an entry that is already there moves');
  assert.deepEqual(orderAfter(['a', 'b', 'c'], ['a'], undefined), ['b', 'c', 'a']);
  assert.deepEqual(orderAfter(['a', 'b'], ['x'], 'zzz'), ['a', 'b', 'x'], 'a place that is not there is the end');
  assert.deepEqual(orderAfter([], ['x'], undefined), ['x']);
  assert.deepEqual(orderAfter(['a', 'b'], ['a', 'b'], 'a'), ['a', 'b'], 'before one of the moved: the moved stay together');
});

test('A request whose name starts like a folder is not taken for something inside it', () => {
  const loaded = shopAndBlog();
  const shop = findChild(loaded, SHOP);
  if (shop === undefined || shop.kind === 'request') throw new Error('fixture');
  const health = findChild(loaded, SHOP + '/health.req.yml');
  if (health === undefined || health.kind !== 'request') throw new Error('fixture');
  shop.children.push({ ...health, path: ORDERS + '-copy.req.yml', slug: 'orders-copy' });
  assert.deepEqual(plan(planDrop(loaded, [ORDERS, ORDERS + '-copy.req.yml'], 'api-client/collections/blog')).nodes, [ORDERS, ORDERS + '-copy.req.yml'], 'both are moved: the request is not inside the folder');
});
