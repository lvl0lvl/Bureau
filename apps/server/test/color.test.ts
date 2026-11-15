import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { staffColor } from '../../../shared/contract.ts';
import { createApp } from '../src/app.ts';
import { DemoEngine } from '../src/engine/demo.ts';

test('a bubble color chosen on a hiring draft is carried to the person, and unknown colors are ignored', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-color-'));
  const app = createApp({ home, engine: new DemoEngine({ speed: 0 }), work: false });
  try {
    assert.equal(staffColor('teal'), '#0e8a8c');
    assert.equal(staffColor('red'), null, 'red already means "needs you"');
    const { hire } = app.hires.propose('wren', { name: 'Marlow', role: 'Finance lead', about: 'Keeps the money side in order.', profile: 'You keep the books.' });
    assert.equal(hire!.color ?? null, null);
    assert.equal(app.hires.edit(hire!.id, { color: 'plum' })!.color, 'plum');
    assert.equal(app.hires.edit(hire!.id, { color: 'chartreuse' })!.color, 'plum');
    const signed = app.hires.sign(hire!.id);
    assert.ok(!('error' in signed));
    assert.equal(app.store.get('staff', (signed as any).staff.id)!.color, 'plum');

    // Setting someone up again starts from the color they have, and can clear it.
    const again = app.hires.propose('wren', { staff: 'Marlow', role: 'Finance and tax' });
    assert.equal(again.hire!.color, 'plum');
    app.hires.edit(again.hire!.id, { color: null });
    app.hires.sign(again.hire!.id);
    assert.equal(app.store.get('staff', (signed as any).staff.id)!.color, null);
  } finally {
    app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
