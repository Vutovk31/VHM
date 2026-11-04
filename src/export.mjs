import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const [input, output] = process.argv.slice(2);
const result = JSON.parse(readFileSync(input, 'utf8'));
const workbook = Workbook.create();

function addSheet(name, columns, records) {
  const sheet = workbook.worksheets.add(name);
  const header = sheet.getRangeByIndexes(0, 0, 1, columns.length);
  header.values = [columns.map(([label]) => label)];
  header.format.fill = '#183450';
  header.format.font.color = '#FFFFFF';
  header.format.font.bold = true;
  header.format.rowHeight = 25;
  if (records.length) {
    sheet.getRangeByIndexes(1, 0, records.length, columns.length).values =
      records.map(record => columns.map(([, read]) => read(record) ?? null));
  }
  columns.forEach(([, , width = 23], index) => {
    sheet.getRangeByIndexes(0, index, records.length + 1, 1).format.columnWidth = width;
  });
  sheet.freezePanes.freezeRows(1);
}

const selected = result.rows.filter(row => ['PRODUCT_PROPOSED', 'ANALOG_PROPOSED'].includes(row.status));
addSheet('Основной подбор', [
  ['Ключ строки', r => r.key], ['Исходный №', r => r.number], ['Лист / страница', r => r.location],
  ['Товарная группа', r => r.group], ['Исходная позиция', r => r.text, 48],
  ['Исходное количество', r => r.sourceQuantity], ['Исходная единица', r => r.unit],
  ['Запросы поиска', r => r.attempts.map(a => a.query).filter(Boolean).join('\n'), 48],
  ['Статус', r => r.status], ['Код ВИ', r => r.card?.viCode], ['ID карточки', r => r.card?.siteProductId],
  ['Артикул производителя', r => r.card?.mpn], ['Товар', r => r.clientText, 55],
  ['Единиц заказа', r => r.quantity], ['Ед. заказа', r => r.card?.pack?.orderUnit],
  ['Цена / ед. заказа', r => r.unitPrice], ['Сумма', r => r.amount],
  ['Валюта', r => r.unitPrice !== null ? r.card.price.currency : null],
  ['Дата цены', r => r.unitPrice !== null ? r.card.price.at : null],
  ['Ссылка', r => r.card?.url, 52], ['Наличие', r => r.stock], ['Доставка', r => r.delivery],
  ['Согласование', r => r.approval], ['Причина / комментарий', r => [r.reason, r.notes].filter(Boolean).join(' · '), 50],
], result.rows);
addSheet('Аналоги', [
  ['Ключ строки', r => r.key], ['Исходный №', r => r.number], ['Исходный товар', r => r.text, 48],
  ['Вид предложения', r => r.status], ['Причина', r => r.reason],
  ['Товар и модель', r => r.clientText, 55], ['Код ВИ', r => r.card.viCode],
  ['Совпадающие параметры', r => r.requirements.filter(x => r.card.checks?.[x.key]?.status === 'PASS').map(x => x.value).join(', '), 45],
  ['Отличия / допущения', r => r.card.differences ?? r.card.assumptions, 48],
  ['Совместимость', r => r.card.compatibility], ['Цена', r => r.unitPrice],
  ['Валюта', r => r.unitPrice !== null ? r.card.price.currency : null],
  ['Дата цены', r => r.unitPrice !== null ? r.card.price.at : null],
  ['Ссылка', r => r.card.url, 52], ['Согласование', r => r.approval],
], selected);
addSheet('Для клиента', [
  ['Исходный №', r => r.number], ['Исходная позиция', r => r.text, 48], ['Результат', r => r.status],
  ['Товар / уточнение', r => r.clientText, 55], ['Отличия / допущения', r => r.card?.differences ?? r.card?.assumptions, 48],
  ['Согласование', r => r.approval],
], result.rows);
const control = [
  ['Заявка', result.requestId], ['Версия политики', result.policyVersion], ['Город', result.city],
  ...Object.entries(result.metrics),
  ...Object.entries(result.rows.reduce((counts, row) => {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }, Object.create(null))),
  ...result.remarks.map(remark => ['Примечание к заявке', remark]),
  ...result.rows.flatMap(row => row.attempts.map(attempt => [
    row.key, attempt.outcome, attempt.channel, attempt.query,
    [attempt.reason, ...(attempt.ids ?? [])].filter(Boolean).join(' · '),
  ])),
];
addSheet('Контроль', [
  ['Показатель / строка', r => r[0], 30], ['Значение / исход', r => r[1], 45], ['Канал', r => r[2]],
  ['Поисковый запрос', r => r[3], 55], ['Причина / ID карточек', r => r[4], 48],
], control);
const file = await SpreadsheetFile.exportXlsx(workbook);
await file.save(output);
for (const [filename, lines] of [['procurement.txt', result.procurement], ['hunter.txt', result.hunter]]) {
  writeFileSync(join(dirname(output), filename), lines.join('\n'), 'utf8');
}
