import { getRunner, EDIT_SUPPORT_MODELS, OPEN_MODELS, NO_EDIT_MODELS, CLOSED_MODELS } from './src/video/core/modelRouter.js';

console.log('\n' + '═'.repeat(60));
console.log('  MODEL ROUTER TEST');
console.log('═'.repeat(60));

console.log('\n📋 OPEN_MODELS         :', OPEN_MODELS);
console.log('📋 EDIT_SUPPORT_MODELS :', EDIT_SUPPORT_MODELS);
console.log('📋 NO_EDIT_MODELS      :', NO_EDIT_MODELS);
console.log('📋 CLOSED_MODELS       :', CLOSED_MODELS);

console.log('\n' + '─'.repeat(60));
console.log('  getRunner() — v2v mode (Edit Support Check)');
console.log('─'.repeat(60));

const editTests = [
    { model: 'kling_o3',               expected: true  },
    { model: 'runway_gen4_aleph',      expected: true  },
    { model: 'seedance_v15_pro',       expected: true  },
    { model: 'seedance_v15_pro_spicy', expected: true  },
    { model: 'kling_v3',               expected: false },
    { model: 'kling_v2',               expected: false },
    { model: 'nanobana_google',        expected: false },
    { model: 'topaz_video_upscale',    expected: false },
];

let pass = 0, fail = 0;
for (const { model, expected } of editTests) {
    const runner = getRunner(model, 'v2v');
    const got    = runner !== null;
    const ok     = got === expected;
    if (ok) pass++; else fail++;
    const icon = ok ? '✅' : '❌';
    console.log(`  ${icon}  ${model.padEnd(28)} → ${got ? 'runner OK' : 'null'} (expected: ${expected ? 'runner' : 'null'})`);
}

console.log('\n' + '─'.repeat(60));
console.log('  getRunner() — t2v/i2v mode (Generation)');
console.log('─'.repeat(60));

const genTests = [
    { model: 'kling_v3',        mode: 't2v' },
    { model: 'kling_o3',        mode: 't2v' },
    { model: 'nanobana_google', mode: 't2v' },
    { model: 'nanobana_google', mode: 'i2v' },
    { model: 'runway_gen4_aleph', mode: 't2v' },
];

for (const { model, mode } of genTests) {
    const runner = getRunner(model, mode);
    const icon   = runner ? '✅' : '⚪';
    console.log(`  ${icon}  ${(model + ' (' + mode + ')').padEnd(34)} → ${runner?.modelName ?? 'null'}`);
}

console.log('\n' + '═'.repeat(60));
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log('═'.repeat(60) + '\n');
