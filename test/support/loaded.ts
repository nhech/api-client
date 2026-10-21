import { newContainer, newRequest, type Container, type Environment, type Request, type Var } from '../../src/core/model';
import type { ContainerNode, EnvironmentNode, Loaded, RequestNode } from '../../src/storage/store';

/** Hand-made trees of what the store loads, for the tests of the parts that read a tree and never the disk. */
export const variable = (name: string, value: string, secret = false): Var => ({ name, value, secret, enabled: true });

export const requestNode = (path: string, request: Request): RequestNode => ({
  kind: 'request', path, slug: (path.split('/').pop() ?? path).replace(/\.req\.yml$/, ''), request, extra: new Map(), findings: []
});

export const containerNode = (kind: 'collection' | 'folder', path: string, container: Container, children: (ContainerNode | RequestNode)[]): ContainerNode => ({
  kind, path, slug: path.split('/').pop() ?? path, container, extra: new Map(), findings: [], children, implicit: false
});

export const environmentNode = (environment: Environment): EnvironmentNode => ({
  kind: 'environment', path: `api-client/environments/${environment.name}.env.yml`, slug: environment.name, environment, extra: new Map(), findings: []
});

export const emptyLoaded = (collections: ContainerNode[] = [], environments: EnvironmentNode[] = []): Loaded => ({
  workspace: { path: 'api-client/workspace.yml', file: { settings: {}, vars: [], collections: [] }, extra: new Map(), findings: [] },
  collections, environments, broken: [], notes: [], truncated: false
});

/**
 * shop
 *   orders/            (folder)
 *     get-order.req.yml
 *     list-orders.req.yml
 *     archive/         (folder)
 *       old.req.yml
 *   health.req.yml
 *   ping.req.yml
 * blog
 *   posts.req.yml
 */
export function shopAndBlog(): Loaded {
  const r = (id: string, name: string): Request => newRequest(id, name);
  const archive = containerNode('folder', 'api-client/collections/shop/orders/archive', newContainer('F2', 'Archive'), [requestNode('api-client/collections/shop/orders/archive/old.req.yml', r('R3', 'Old'))]);
  const orders = containerNode('folder', 'api-client/collections/shop/orders', newContainer('F1', 'Orders'), [
    requestNode('api-client/collections/shop/orders/get-order.req.yml', r('R1', 'Get order')), requestNode('api-client/collections/shop/orders/list-orders.req.yml', r('R2', 'List orders')), archive
  ]);
  const shop = containerNode('collection', 'api-client/collections/shop', newContainer('C1', 'Shop'), [
    orders, requestNode('api-client/collections/shop/health.req.yml', r('R4', 'Health')), requestNode('api-client/collections/shop/ping.req.yml', r('R5', 'Ping'))
  ]);
  const blog = containerNode('collection', 'api-client/collections/blog', newContainer('C2', 'Blog'), [requestNode('api-client/collections/blog/posts.req.yml', r('R6', 'Posts'))]);
  return emptyLoaded([shop, blog]);
}
