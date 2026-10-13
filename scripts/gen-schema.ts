import { writeFileSync } from 'node:fs';
import { generateSchemaMarkdown } from '../src/config/schema-doc.js';

writeFileSync('config/SCHEMA.md', generateSchemaMarkdown() + '\n');
console.log('wrote config/SCHEMA.md');
