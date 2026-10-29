import { URL } from 'node:url';
import { buildHostViewExample } from '../../../scripts/build-plugin-view-example.mjs';
await buildHostViewExample(new URL('./', import.meta.url));
