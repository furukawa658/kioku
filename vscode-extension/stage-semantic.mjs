import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const MODEL_REPO = 'Xenova/multilingual-e5-small';
export const MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const MODEL_ASSETS = [
  { file: 'config.json', bytes: 658 },
  { file: 'tokenizer_config.json', bytes: 443 },
  { file: 'special_tokens_map.json', bytes: 167 },
  { file: 'tokenizer.json', bytes: 17082730, sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
  { file: 'onnx/model_quantized.onnx', bytes: 118308185, sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' },
  { file: 'README.md', bytes: 1077 },
];

export async function download(url, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  // 取得先URLはコミット固定のため、取得済みの資材は再取得しない
  if ((await stat(destination).catch(() => null))?.size > 0) {
    console.log(`DOWNLOAD_CACHED ${path.basename(destination)}`);
    return;
  }
  const temporary = destination + '.part';
  const started = Date.now();
  console.log(`DOWNLOAD_START ${path.basename(destination)}`);
  const progress = setInterval(() => {
    console.log(`DOWNLOAD_PROGRESS ${path.basename(destination)} elapsed_s=${Math.floor((Date.now() - started) / 1000)}`);
  }, 5000);
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
    await rename(temporary, destination);
    console.log(`DOWNLOAD_DONE ${path.basename(destination)} bytes=${(await stat(destination)).size}`);
  } catch (error) {
    await rm(temporary, { force: true });
    console.error(`DOWNLOAD_FAILED ${path.basename(destination)}`);
    throw error;
  } finally { clearInterval(progress); }
}

export async function verifyModelAsset(filename, asset) {
  try {
    if ((await stat(filename)).size !== asset.bytes) return false;
    return !asset.sha256 || createHash('sha256').update(await readFile(filename)).digest('hex') === asset.sha256;
  } catch { return false; }
}

export async function stageSemantic(repo, runtime) {
  const started = Date.now();
  const semantic = path.join(runtime, 'semantic');
  await mkdir(semantic, { recursive: true });
  await cp(path.join(repo, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs'), path.join(semantic, 'transformers.mjs'));
  const notices = [];
  const packages = ['onnxruntime-node', 'onnxruntime-common'];
  const excludedBinaries = /^(directml\.dll|dxcompiler\.dll|dxil\.dll|libonnxruntime_providers_(cuda|tensorrt)\b.*)$/i;
  for (const [index, name] of packages.entries()) {
    const source = path.join(repo, 'node_modules', name);
    const destination = path.join(runtime, 'node_modules', name);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await mkdir(destination, { recursive: true });
    await cp(path.join(source, 'package.json'), path.join(destination, 'package.json'));
    if (name === 'onnxruntime-node') {
      await cp(path.join(source, 'dist'), path.join(destination, 'dist'), {
        recursive: true, filter: file => !/\.(?:d\.ts|map)$/i.test(file),
      });
      await cp(path.join(source, `bin/napi-v6/${process.platform}/${process.arch}`), path.join(destination, `bin/napi-v6/${process.platform}/${process.arch}`), {
        recursive: true, filter: file => !excludedBinaries.test(path.basename(file)),
      });
    } else {
      for (const format of ['cjs', 'esm']) {
        await cp(path.join(source, 'dist', format), path.join(destination, 'dist', format), {
          recursive: true, filter: file => !/\.(?:d\.ts|map)$/i.test(file),
        });
      }
    }
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    notices.push(`${name}@${manifest.version}: ${manifest.license || 'see package license'}`);
    console.log(`SEMANTIC_PACKAGE ${index + 1}/${packages.length} ${name}`);
  }
  // 画像処理は使わないため、transformersのimportを満たす空のsharpを置く
  const sharpStub = path.join(runtime, 'node_modules', 'sharp');
  await rm(sharpStub, { recursive: true, force: true });
  await mkdir(sharpStub, { recursive: true });
  await writeFile(path.join(sharpStub, 'package.json'), JSON.stringify({ name: 'sharp', version: '0.0.0-kioku-stub', main: 'index.js' }));
  await writeFile(path.join(sharpStub, 'index.js'), "module.exports = function sharp() { throw new Error('image processing is not bundled'); };\n");
  for (const name of [...packages, '@huggingface/transformers']) {
    const source = path.join(repo, 'node_modules', name);
    const licenses = (await readdir(source)).filter(file => /^(license|licence|notice|copying|thirdpartynotices)([-.]|$)/i.test(file));
    if (!licenses.length && name.startsWith('onnxruntime-')) {
      const version = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')).version;
      for (const file of ['LICENSE', 'ThirdPartyNotices.txt']) {
        await download(`https://raw.githubusercontent.com/microsoft/onnxruntime/v${version}/${file}`,
          path.join(runtime, 'licenses', `${name}-${file}`));
      }
      continue;
    }
    if (!licenses.length) throw new Error(`Missing semantic redistribution license: ${name}`);
    for (const file of licenses) await cp(path.join(source, file), path.join(runtime, 'licenses', `${name.replaceAll('/', '-')}-${file}`));
  }
  const modelRoot = path.join(runtime, 'models', MODEL_REPO);
  for (const [index, asset] of MODEL_ASSETS.entries()) {
    const destination = path.join(modelRoot, asset.file);
    if (!await verifyModelAsset(destination, asset)) {
      await download(`https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${asset.file}`, destination);
      if (!await verifyModelAsset(destination, asset)) throw new Error(`Model integrity mismatch: ${asset.file}`);
    }
    console.log(`SEMANTIC_MODEL ${index + 1}/${MODEL_ASSETS.length} ${asset.file}`);
  }
  await download('https://huggingface.co/intfloat/multilingual-e5-small/resolve/614241f622f53c4eeff9890bdc4f31cfecc418b3/README.md', path.join(runtime, 'licenses', 'multilingual-e5-small-model-card.md'));
  await download('https://raw.githubusercontent.com/microsoft/unilm/master/LICENSE', path.join(runtime, 'licenses', 'multilingual-e5-small-MIT-LICENSE'));
  notices.push(`Model: ${MODEL_REPO}@${MODEL_REVISION}; intfloat/multilingual-e5-small (MIT), q8, 384 dimensions. See model cards and MIT license.`);
  console.log(`SEMANTIC_STAGED packages=${packages.length} model_files=${MODEL_ASSETS.length} elapsed_s=${Math.floor((Date.now() - started) / 1000)}`);
  return notices;
}