import { createHash } from 'node:crypto';
import { evaluateCharacteristics } from './technical-checks.mjs';

const present = value => typeof value === 'string' && value.trim() !== '';
const normalize = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
const syntax = new Set(['по','для','с','со','и','из','на','в','во','к','от','арт','артикул','код','модель','тип','объемом','объёмом']);
export const sourceDigest = row => createHash('sha256').update(JSON.stringify(row.original)).digest('hex');

function fragments(row) {
  const result = new Map([['text', row.text]]);
  const notes = Array.isArray(row.original.notes) ? row.original.notes : [row.original.notes];
  notes.forEach((note, index) => {
    if (note !== undefined && note !== null && String(note).trim()) result.set('notes.' + index, String(note));
  });
  return result;
}

export function buildInterpretationRequest(snapshot) {
  return {
    requestId: snapshot.requestId, policyVersion: snapshot.policyVersion,
    rows: snapshot.rows.filter(row => !row.requirements.length || row.interpretation?.mode === 'REVIEW').map(row => ({
      key: row.key, sourceDigest: sourceDigest(row), number: row.number,
      fragments: Object.fromEntries(fragments(row)), requestedQuantity: row.quantity, requestedUnit: row.unit,
      analysis: row.analysis,
    })),
  };
}

/** Checks grounding and source coverage. Semantic correctness remains an evidence gate. */
export function applyInterpretation(snapshot, response, request = buildInterpretationRequest(snapshot)) {
  if (response?.requestId !== snapshot.requestId || !present(response.actor) ||
      !Array.isArray(response.rows) || response.rows.length !== request.rows.length) {
    throw new Error('Invalid host interpretation envelope');
  }
  const requested = new Map(request.rows.map(row => [row.key, row]));
  const reviewed = new Map();
  for (const review of response.rows) {
    const row = snapshot.rows.find(item => item.key === review.key);
    if (!row || !requested.has(review.key) || reviewed.has(review.key) ||
        review.sourceDigest !== requested.get(review.key).sourceDigest ||
        review.sourceDigest !== sourceDigest(row)) throw new Error('Unknown, duplicate or stale interpreted row');
    if (!['STRICT','OPEN','CLARIFY','REVIEW'].includes(review.mode) || !present(review.category) ||
        !Array.isArray(review.requirements) || !Array.isArray(review.claims)) {
      throw new Error('Invalid row interpretation');
    }
    if (review.brand && row.analysis.brands.length &&
        !row.analysis.brands.some(item => normalize(item.value) === normalize(review.brand))) {
      throw new Error('Interpreted brand conflicts with source');
    }
    if (row.product.brand && review.brand && normalize(row.product.brand) !== normalize(review.brand)) {
      throw new Error('Interpreted brand conflicts with an explicit brand');
    }
    if (row.product.category && row.product.category !== 'UNCLASSIFIED' && normalize(row.product.category) !== normalize(review.category)) {
      throw new Error('Interpreted category conflicts with an explicit category');
    }
    if (review.mode === 'OPEN' && (review.brand || row.analysis.brands.length || row.product.brand ||
        row.product.model || row.product.mpn || row.product.viCode || row.product.siteProductId)) {
      throw new Error('Open interpretation cannot replace an explicit identity');
    }
    const sources = fragments(row);
    const covered = new Map([...sources].map(([field]) => [field, new Set()]));
    const bindings = new Map();
    const axisQuestions = { QUANTITY: [], DELIVERY: [], QUOTE: [] };
    let unresolved = false;
    const requirements = new Map();
    for (const item of review.requirements) {
      if (!present(item?.key) || !present(item.value) || !present(item.field) || !item.test ||
          requirements.has(item.key)) throw new Error('Host requirements must be unique, typed and explicit');
      requirements.set(item.key, item);
    }
    evaluateCharacteristics([...requirements.values()], [], 'interpretation-validation');
    for (const claim of review.claims) {
      const span = claim.source, raw = sources.get(span?.field);
      if (!raw || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) ||
          span.start < 0 || span.end <= span.start || span.end > raw.length ||
          raw.slice(span.start, span.end) !== span.text) throw new Error('Invalid source span');
      if (!['REQUIREMENT','BRAND','CATEGORY','SYNTAX','UNRESOLVED','QUANTITY','DELIVERY','QUOTE'].includes(claim.role)) {
        throw new Error('Invalid source disposition');
      }
      if (claim.role === 'SYNTAX' && span.text.split(/\s+/u).some(word => !syntax.has(normalize(word)))) {
        throw new Error('Technical text cannot be discarded as syntax');
      }
      if (claim.role === 'CATEGORY' && !(span.field === 'text' &&
          span.start === row.analysis.category?.source.start && span.end === row.analysis.category?.source.end)) {
        throw new Error('Category disposition must use the detected source span');
      }
      if (claim.role === 'BRAND' && !(span.field === 'text' && row.analysis.brands.some(brand =>
        span.start === brand.source.start && span.end === brand.source.end))) throw new Error('Invalid brand disposition');
      if (claim.role === 'REQUIREMENT') {
        if (!Array.isArray(claim.keys) || !claim.keys.length || claim.keys.some(key => !requirements.has(key))) {
          throw new Error('Requirement disposition lacks a matching technical test');
        }
        for (const key of claim.keys) bindings.set(key, [...(bindings.get(key) ?? []), span]);
      }
      if (claim.role === 'UNRESOLVED') unresolved = true;
      if (Object.hasOwn(axisQuestions, claim.role)) {
        const keywords = { QUANTITY: /колич|комплект|фасов|упаков|шт|флакон|метр|бухт|излиш|кратн|отгруз/iu,
          DELIVERY: /достав|самовывоз|адрес|срок|регион|объект|город|налич/iu,
          QUOTE: /цен|руб|ндс|стоим|оплат/iu };
        if (!span.field.startsWith('notes.') || !present(claim.question) || !keywords[claim.role].test(span.text)) {
          throw new Error('Invalid nontechnical clarification disposition');
        }
        axisQuestions[claim.role].push(claim.question);
      }
      for (let i = span.start; i < span.end; i++) covered.get(span.field).add(i);
    }
    const missing = [...sources].some(([field, raw]) => Array.from({length:raw.length},(_,i)=>i).some(i =>
      !covered.get(field).has(i) && !/[\s,.;:()[\]]/u.test(raw[i])));
    if ([...requirements.keys()].some(key => !bindings.has(key))) throw new Error('Ungrounded technical requirement');
    const ambiguousSetCount = /^\s*набор\s+отв[её]рток(?!\p{L})/iu.test(row.text) &&
      [...requirements.values()].some(item => normalize(item.field) === 'количество в наборе' &&
        item.test.kind === 'number' &&
        (bindings.get(item.key) ?? []).some(span => span.field === 'text' && /^\d+\s*шт\.?$/iu.test(span.text.trim()) &&
          !/^\s*(?:предметов|предмета|позиций)(?!\p{L})/iu.test(row.text.slice(span.end))));
    const question = review.question || (ambiguousSetCount
      ? 'Указанное число относится ко всем предметам набора или только к изделиям указанного типа?'
      : undefined);
    const clarify = row.original.kind === 'CLARIFY' || review.mode === 'CLARIFY' || unresolved || missing || !requirements.size ||
      ambiguousSetCount ||
      row.analysis.brands.length > 1;
    const internalReview = review.mode === 'REVIEW' && row.original.kind !== 'CLARIFY';
    if (internalReview && !present(review.reviewReason)) throw new Error('Internal review requires a specific reason');
    if (clarify && !internalReview && !present(question)) throw new Error('Unresolved interpretation requires a specific question');
    reviewed.set(review.key, {
      ...row, product: {...row.product, category:review.category,
        brand:review.brand || row.product.brand || (row.analysis.brands.length===1?row.analysis.brands[0].value:'')},
      requirements:[...requirements.values()].map(item => ({...item,sources:bindings.get(item.key)})),
      quantityClarification: row.quantityClarification || axisQuestions.QUANTITY.join('\n'),
      deliveryClarification: row.deliveryClarification || axisQuestions.DELIVERY.join('\n'),
      quoteClarification: row.quoteClarification || axisQuestions.QUOTE.join('\n'),
      interpretation:{actor:response.actor,sourceDigest:review.sourceDigest,complete:!clarify && !internalReview,
        mode:internalReview?'REVIEW':clarify?'CLARIFY':review.mode,
        question:clarify && !internalReview?question:undefined,
        reviewReason:internalReview?review.reviewReason:undefined,claims:review.claims},
    });
  }
  if (reviewed.size !== requested.size) throw new Error('Host interpretation omitted source rows');
  return {...snapshot,rows:snapshot.rows.map(row=>reviewed.get(row.key)??row)};
}

export async function interpretThroughHost(snapshot, transport, signal) {
  const request = buildInterpretationRequest(snapshot);
  const batchSize = 20;
  let output = snapshot;
  for (let offset = 0; offset < request.rows.length; offset += batchSize) {
    signal?.throwIfAborted();
    const batch = {...request, rows:request.rows.slice(offset,offset+batchSize)};
    const result = await transport.invoke('normalize_request', batch, {signal});
    const response = result?.structuredContent;
    const ref = await transport.persist({method:'normalize_request',at:new Date().toISOString(),request:batch,response});
    if (!present(ref)) throw new Error('Host interpretation evidence reference is required');
    output = applyInterpretation(output,response,batch);
    output.remarks = [...output.remarks,{code:'HOST_TECHNICAL_INTERPRETATION',ref}];
  }
  return output;
}
