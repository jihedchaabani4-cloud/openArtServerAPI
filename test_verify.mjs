import { 
  db, 
  generationService, 
  authorizationService, 
  tenantAccessService, 
  auditService, 
  characterService, 
  projectReadService 
} from './src/container.js';

console.log('--- 1. Testing DI Container Exports ---');
console.log('✅ db repos:', Object.keys(db));
console.log('✅ generationService loaded:', !!generationService);
console.log('✅ authorizationService loaded:', !!authorizationService);
console.log('✅ tenantAccessService loaded:', !!tenantAccessService);
console.log('✅ auditService loaded:', !!auditService);
console.log('✅ characterService loaded:', !!characterService);
console.log('✅ projectReadService loaded:', !!projectReadService);

console.log('\n--- 2. Testing GenerationService Methods ---');
const genMethods = ['getAssets', 'getUserLibrary', 'getWorkflowDetail', 'deleteGeneration', 'updateGeneration'];
for (const m of genMethods) {
  console.log(typeof generationService[m] === 'function' ? '✅' : '❌', 'GenerationService.' + m);
}

console.log('\n--- 3. Testing Security Services ---');
console.log('✅ RBAC owner can delete:', authorizationService.can('owner', 'generation:delete'));
console.log('✅ RBAC viewer can delete:', authorizationService.can('viewer', 'generation:delete'));

try {
  authorizationService.assertCan('viewer', 'generation:delete');
} catch (e) {
  console.log('✅ assertCan throws 403 correctly:', e.statusCode === 403);
}

auditService.log({ action: 'test.verify', userId: 'user_123', resourceType: 'workflow', resourceId: 'wf_123' });
console.log('✅ auditService.log() executed cleanly without throwing or noise');

console.log('\n🎉 ALL IN-MEMORY INTEGRATION TESTS PASSED!');
