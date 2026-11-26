import { AdminServer } from '../src/index.ts';
import { createFixtureReader } from './fixtures.ts';

const port = process.env.TSUGIMORI_PREVIEW_PORT ?? '8788';
const { reader } = createFixtureReader(process.argv.includes('--empty'));
const server = new AdminServer(
  { reader },
  { allowLocalWithoutAccess: true, listen: '127.0.0.1:' + port },
);
const address = await server.start();
console.log('Fixture console at http://127.0.0.1:' + address.port);
for (const event of ['SIGINT', 'SIGTERM'])
  process.once(event, () => void server.stop());
