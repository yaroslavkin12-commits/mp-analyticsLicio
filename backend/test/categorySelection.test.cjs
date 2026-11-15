const {test}=require('node:test'),assert=require('node:assert/strict');
const source=()=>import('../../dashboard/src/lib/categorySelection.js');
test('Категории по веткам: привычный порядок, без дублей, подкатегории остаются в своей ветке',async()=>{
 const {categoryBranches}=await source();const b=categoryBranches(['Одежда / Футболки','Дефлекторы / Окна / PSA','Чехлы','Дефлекторы / Окна / 2D','Аксессуары','Утеплители','Чехлы']);
 assert.deepEqual(b.map(x=>x.root),['Чехлы','Дефлекторы','Утеплители','Аксессуары','Одежда']);assert.equal(b[1].paths.length,2);assert.equal(b[0].paths.length,1);
});
test('Выбор родителя заменяет вложенные пути, включает детей и не меняет другие ветки',async()=>{
 const {toggleCategory,categorySelection}=await source();const paths=['Дефлекторы / Окна / 2D','Дефлекторы / Капот','Чехлы'];
 const selected=toggleCategory(paths,'Дефлекторы / Окна');assert.deepEqual(selected,['Дефлекторы / Капот','Чехлы','Дефлекторы / Окна']);
 assert.deepEqual(categorySelection(selected,'Дефлекторы / Окна / 3D'),{checked:true,inherited:true,partial:false});assert.equal(categorySelection(selected,'Дефлекторы').partial,true);
 assert.deepEqual(toggleCategory(selected,'Дефлекторы / Окна / 3D'),selected);
 assert.deepEqual(toggleCategory(selected,'Дефлекторы / Окна'),['Дефлекторы / Капот','Чехлы']);
});
