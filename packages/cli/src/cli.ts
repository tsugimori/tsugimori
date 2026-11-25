#!/usr/bin/env node
import { main, reportError } from './index.ts';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  reportError(error);
  process.exitCode = 1;
}
