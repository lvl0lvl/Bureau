import os from 'node:os';
import path from 'node:path';
import { Auth } from './auth.ts';
import { Store } from './store.ts';

/** Small command-line helpers that work on the office folder directly. */

const demo = process.env.BUREAU_DEMO === '1';
const home = process.env.BUREAU_HOME ?? path.join(os.homedir(), demo ? 'Bureau-demo' : 'Bureau');
const command = process.argv[2];

if (command === 'pair') {
  const store = new Store(path.join(home, 'bureau.db'));
  const { code } = new Auth(store).createCode();
  store.close();
  console.log(`Pairing code: ${code.slice(0, 4)}-${code.slice(4)}`);
  console.log('Open Bureau on the other device, enter this code within 10 minutes. It works once.');
} else {
  console.log('Usage: pnpm pair    Make a one-time code for pairing another device.');
}
