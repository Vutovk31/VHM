const brands = [
  ['Inforce', ['Inforce']], ['Gigant', ['Gigant']], ['AEG', ['AEG']], ['Ryobi', ['Ryobi']],
  ['KEYANG', ['KEYANG', 'КЕЯНГ']], ['Grizzly', ['Grizzly']], ['ATLET', ['ATLET', 'Атлет']],
  ['KENDO', ['KENDO']], ['DCA', ['DCA']], ['Makita', ['Makita', 'Макита']],
  ['HOEGERT', ['HOEGERT', 'Högert']], ['CUTOP', ['CUTOP']], ['FIT', ['FIT']],
  ['GROSS', ['GROSS']], ['КВТ', ['КВТ']], ['KNIPEX', ['KNIPEX']],
  ['Jonnesway', ['Jonnesway']], ['ЗУБР', ['ЗУБР']], ['WERA', ['WERA']],
  ['IZELTAS', ['IZELTAS', 'İZELTAŞ']], ['NEO Tools', ['NEO Tools']], ['DEKO', ['DEKO']],
  ['Felo', ['Felo']], ['Вершина', ['Вершина']], ['ARNO INDUSTRIES', ['ARNO INDUSTRIES']],
  ['23 БОЛТА', ['23 БОЛТА']], ['Top Tools', ['Top Tools']], ['KRAFTOOL', ['KRAFTOOL']],
  ['KING TONY', ['KING TONY']], ['WURTH', ['WURTH']], ['MATRIX', ['MATRIX']],
  ['STAYER', ['STAYER']], ['Milwaukee', ['Milwaukee']], ['JTC', ['JTC']],
  ['ЭРА', ['ЭРА']], ['АвтоДело', ['АвтоДело']], ['Дело Техники', ['Дело Техники']],
];
const categories = [
  ['АКБ', /аккумулятор(?!н)[\p{L}]*/iu], ['зарядное устройство', /зарядн[\p{L}]* устройств[\p{L}]*/iu],
  ['дрель-шуруповёрт', /дрел[\p{L}]*[ -]шурупов[её]рт[\p{L}]*/iu],
  ['перфоратор', /перфоратор[\p{L}]*/iu], ['гайковёрт', /гайков[её]рт[\p{L}]*/iu],
  ['шуруповёрт', /шурупов[её]рт[\p{L}]*/iu], ['УШМ', /(?:шлифмашин[\p{L}]*|шлифовальн[\p{L}]* машин[\p{L}]*|УШМ)/iu],
  ['технический фен', /(?:техническ[\p{L}]* фен|фен техническ[\p{L}]*)/iu],
  ['бур', /бур(?:ы|а|ов)?(?=$|[^\p{L}])/iu], ['пресс', /(?<!\p{L})пресс(?:-клещи|а|ом|ы|ов|е)?(?!\p{L})/iu],
  ['бокорезы', /бокорез[\p{L}]*/iu], ['длинногубцы', /длинногубц[\p{L}]*/iu],
  ['пассатижи', /пассатиж[\p{L}]*/iu], ['клещи', /клещ[\p{L}]*/iu],
  ['отвёртка', /отв[её]рт(?:к|ок)[\p{L}]*/iu], ['рулетка', /рулетк[\p{L}]*/iu],
  ['пистолет для герметика', /пистолет[\p{L}]* для герметик[\p{L}]*/iu],
  ['щупы мультиметра', /щуп[\p{L}]* для мультиметр[\p{L}]*/iu],
  ['молоток', /молот(?:ок|к[\p{L}]*)/iu], ['кувалда', /кувалд[\p{L}]*/iu],
  ['ключ', /ключ(?:и|ей|а|ом)?(?=$|[^\p{L}])/iu], ['саморез', /саморез[\p{L}]*/iu],
  ['фонарь', /фонар[\p{L}]*/iu], ['замок', /зам(?:ок|к[\p{L}]*)/iu],
  ['обезжириватель', /обезжиривател[\p{L}]*/iu], ['паяльник', /паяльник[\p{L}]*/iu],
  ['нож', /нож(?:и|а|ом)?(?=$|[^\p{L}])/iu], ['кисть', /кист[\p{L}]*/iu],
  ['валик', /валик[\p{L}]*/iu], ['шпатель', /шпател[\p{L}]*/iu],
  ['съёмник', /(?<!\p{L})съ[её]мник[\p{L}]*/iu],
  ['инструмент для снятия заусенцев', /инструмент[\p{L}]* для снятия заусенцев/iu],
  ['набор бит и головок', /набор[\p{L}]* бит и головок/iu],
  ['набор инструмента', /набор[\p{L}]* инструмент(?:а|ов)(?!\p{L})/iu],
  ['инструментальная тележка', /(?:тележк[\p{L}]* инструментальн[\p{L}]*|инструментальн[\p{L}]* тележк[\p{L}]*)/iu],
  ['изолента', /(?<!\p{L})изолент[\p{L}]*/iu],
  ['резец', /(?<!\p{L})рез(?:ец|ц(?:ы|а|ов|ом))(?!\p{L})/iu],
  ['продувочный пистолет', /(?:пистолет[\p{L}]* для продувки|продувочн[\p{L}]* пистолет[\p{L}]*)/iu],
  ['набор головок', /набор[\p{L}]* головок/iu],
  ['талреп', /(?<!\p{L})талреп[\p{L}]*/iu],
  ['круглогубцы', /(?<!\p{L})круглогубц[\p{L}]*/iu],
  ['кернер', /(?<!\p{L})кернер[\p{L}]*/iu],
  ['пневматическая трещотка', /пневматическ[\p{L}]* трещ[оё]тк[\p{L}]*/iu],
  ['набор напильников', /набор[\p{L}]* напильников/iu],
];
const escape = value => value.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
const excludedCodes = /^(?:CrV|CrMoV|SDS-plus|Li-Ion|LXT|VDE|HEX|TORX|PH\d*|PZ\d*|IP\d+|А\d|A\d|\d+(?:T|В|V|Вт|мм|Ач|g|мл|шт))$/iu;

function sourceSpan(match, original, offset = 0) {
  const start = match.index + offset;
  return { start, end: start + original.length, text: original };
}

/** Search hints preserve original spans and leave technical completeness unverified. */
export function extractProductText(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Product text is required');
  const foundBrands = [];
  for (const [canonical, aliases] of brands) {
    for (const alias of aliases) {
      const match = new RegExp('(^|[^\\p{L}\\p{N}])(' + escape(alias) + ')(?=$|[^\\p{L}\\p{N}])', 'iu').exec(input);
      if (match) {
        foundBrands.push({ value: canonical, source: sourceSpan(match, match[2], match[1].length) });
        break;
      }
    }
  }
  const foundCategories = categories.flatMap(([value, pattern]) => {
    const match = pattern.exec(input);
    return match ? [{ value, source: sourceSpan(match, match[0]) }] : [];
  });
  const category = foundCategories[0] ?? null;
  const identifiers = [];
  for (const match of input.matchAll(/[\p{L}\p{N}]+(?:[-./][\p{L}\p{N}]+)*/gu)) {
    const token = match[0];
    if (!/\d/u.test(token) || token.length < 4 || excludedCodes.test(token) ||
        /^\d+(?:[.,]\d+)?(?:[xх×]\d+(?:[.,]\d+)?)+(?:mm|мм)?$/iu.test(token)) continue;
    const mixed = /\p{L}/u.test(token) && /\p{N}/u.test(token);
    const separatedCode = /^\d{2,}(?:-\d{2,})+$/u.test(token);
    const longNumber = /^\d{7,}$/u.test(token);
    if (mixed || separatedCode || longNumber) {
      identifiers.push({ value: token, type: 'UNKNOWN', source: sourceSpan(match, token) });
    }
  }
  const measures = [];
  const pattern = /(\d+(?:[.,]\d+)?(?:\s*[xх×]\s*\d+(?:[.,]\d+)?){0,2})\s*(мм|mm|см|мл|кг|Нм|Вт|кВт|А[·*]?ч|Ач|л|м|г|В)(?=$|[^\p{L}])/giu;
  for (const match of input.matchAll(pattern)) {
    measures.push({ value: match[1].replace(/\s/gu, '').replace(/,/gu, '.').replace(/[х×]/gu, 'x'),
      unit: match[2], source: sourceSpan(match, match[0]), meaning: 'UNRESOLVED' });
  }
  const codeHints = identifiers.filter(identifier => !measures.some(measure =>
    identifier.source.start >= measure.source.start && identifier.source.end <= measure.source.end));
  const issues = [];
  if (foundBrands.length > 1) issues.push('MULTIPLE_BRANDS_IN_SOURCE');
  if (!category) issues.push('CATEGORY_UNRESOLVED');
  if (codeHints.length) issues.push('IDENTIFIER_TYPE_UNRESOLVED');
  return { brands: foundBrands, category, identifiers: codeHints, measures, issues, completeness: 'REQUIRES_TECHNICAL_REVIEW' };
}
