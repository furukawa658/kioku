import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MODEL_ASSETS, MODEL_REVISION, verifyModelAsset } from '../stage-semantic.mjs';

test('model distribution pins quantized multilingual weights and their checksum', () => {
  assert.match(MODEL_REVISION, /^[a-f0-9]{40}$/);
  const weights = MODEL_ASSETS.find(asset => asset.file.endsWith('.onnx'));
  assert.equal(weights.file, 'onnx/model_quantized.onnx');
  assert.match(weights.sha256, /^[a-f0-9]{64}$/);
  assert.ok(MODEL_ASSETS.some(asset => asset.file === 'tokenizer.json' && asset.sha256));
});

test('cached assets must match expected size and checksum', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kioku-model-'));
  try {
    const file = path.join(directory, 'fixture');
    const asset = { bytes: 3, sha256: createHash('sha256').update('abc').digest('hex') };
    assert.equal(await verifyModelAsset(file, asset), false);
    await writeFile(file, 'abc');
    assert.equal(await verifyModelAsset(file, asset), true);
    await writeFile(file, 'def');
    assert.equal(await verifyModelAsset(file, asset), false);
    await writeFile(file, 'abcd');
    assert.equal(await verifyModelAsset(file, asset), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});