import { RelayPipeline } from '../../lib/relay/pipeline.mjs';
import { RuntimeService } from '../../lib/runtime/service.mjs';
import { SQLiteRuntimeStore } from '../../lib/runtime/sqlite-store.mjs';

const store = new SQLiteRuntimeStore(':memory:');
const service = new RuntimeService({ store, pipeline: new RelayPipeline({ store }) });
await service.start({ pollMs: 25 });
