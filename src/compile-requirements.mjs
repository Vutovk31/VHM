import { extractProductText } from './normalize-product.mjs';

/** Parses a fully covered battery description; uncovered text keeps review open. */
export function compileTechnicalRequirements(source) {
  const analysis = extractProductText(source.text);
  const covered = new Set();
  const requirements = [];
  function consume(span) {
    for (let i = span.start; i < span.end; i++) covered.add(i);
  }
  function requirement(key, value, field, test, span) {
    consume(span);
    requirements.push({ key, value, field, test, source: { field:'text', ...span } });
  }
  const category = /^аккумулятор(?=\s)/iu.exec(source.text);
  if (!category) return { profile:null, complete:false, requirements:[], issues:['UNSUPPORTED_DESCRIPTION_PROFILE'] };
  consume({start:category.index,end:category.index+category[0].length});
  const issues=[];
  const typeSource = {start:category.index,end:category.index+category[0].length,text:category[0]};
  for (const [key, token] of [['not-set', 'набор'], ['not-kit', 'комплект']]) {
    requirement(key, 'Отдельный аккумулятор', '@title', {kind:'notToken',expected:token}, typeSource);
  }
  if (analysis.brands.length !== 1) issues.push('BRAND_UNRESOLVED');
  for (const brand of analysis.brands) consume(brand.source);
  if (source.brand && source.brand.toLowerCase() !== analysis.brands[0]?.value.toLowerCase()) issues.push('EXPLICIT_BRAND_CONFLICT');

  for (let i=0;i<analysis.identifiers.length;i++) {
    const identifier=analysis.identifiers[i];
    requirement('identity-'+i,identifier.value,'@title',{kind:'token',expected:identifier.value},identifier.source);
  }
  if (!analysis.identifiers.length) issues.push('IDENTITY_UNRESOLVED');

  for (const [key, field, units, canonical] of [
    ['voltage','Напряжение',['В'],'В'],
    ['capacity','Емкость аккумулятора',['Ач','А·ч','А*ч'],'Ач'],
  ]) {
    const matches=analysis.measures.filter(measure=>units.includes(measure.unit));
    if (matches.length !== 1 || !/^\d+(?:\.\d+)?$/u.test(matches[0]?.value??'') || Number(matches[0].value) <= 0) {
      issues.push(key.toUpperCase()+'_UNRESOLVED');
      continue;
    }
    const measure=matches[0];
    requirement(key,measure.source.text,field,{kind:'number',expected:Number(measure.value),unit:canonical},measure.source);
  }
  for (const [key, pattern, field, test] of [
    ['chemistry',/\bLi-Ion\b/iu,'Тип аккумулятора',{kind:'text',expected:'Li-Ion'}],
    ['indicator',/индикатор заряда/iu,'Индикатор заряда',{kind:'boolean',expected:true}],
    ['platform',/\bLXT\b/u,'@title',{kind:'token',expected:'LXT'}],
  ]) {
    const match=pattern.exec(source.text);
    if (match) requirement(key,match[0],field,test,{start:match.index,end:match.index+match[0].length,text:match[0]});
  }
  for (const match of source.text.matchAll(/(^|[\s,;])для(?=\s)/giu)) {
    const start=match.index+match[1].length;
    // "для" is consumed only when immediately followed by the explicitly checked platform.
    if (/^\s+LXT(?=$|[^\p{L}\p{N}])/u.test(source.text.slice(start+3))) consume({start,end:start+3});
  }
  const uncovered = [];
  let start=null;
  for(let i=0;i<=source.text.length;i++){
    const meaningful=i<source.text.length&&!covered.has(i)&&!/[\s,.;:()[\]]/u.test(source.text[i]);
    if(meaningful&&start===null) start=i;
    if(!meaningful&&start!==null){uncovered.push({start,end:i,text:source.text.slice(start,i)});start=null}
  }
  if(uncovered.length) issues.push('UNPARSED_SOURCE_TEXT');
  const notes=Array.isArray(source.notes)?source.notes:[source.notes];
  if(notes.some(note=>note!==undefined&&note!==null&&String(note).trim())) issues.push('SOURCE_NOTES_REQUIRE_REVIEW');
  return { profile:'battery-description-v1',complete:issues.length===0,requirements,issues,uncovered,
    category:'АКБ',brand:analysis.brands.length===1?analysis.brands[0].value:null };
}
