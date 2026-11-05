# E03.5 · Ground truth

Corpus SHA-256 `b8526055c517a4a246f8560d16b4c4de1ae84dadfa7fb92c563eee2d12f2c5b3`. Original workbook SHA-256 `df93bebffaacfdf78a9df15036c76a2bb27b635fe7f50f8e7c1040bd84375537`. Sample SHA-256 `5443f9578a9d01fef1e447947ee2b0e635fa1144adbc6c8115e4b5f91f692ffc`. Candidate-map SHA-256 `615782d7d7258098eacb7e59bb3310178158f187919fc9a575e56ec205499ca1`.

Original line numbers: 2, 3, 4, 6, 7, 10, 11, 13, 14, 23, 24, 27, 46, 51, 55, 64, 98, 113, 124, 126, 139, 141, 149, 150, 174, 176, 182, 202, 204, 205.

The local `runs/client-pilot/e035/golden.json` contains all 30 original rows, quantities, units and reviewed requirements. Four rows have independent manufacturer references and a reviewed crosswalk to catalog IDs. The remaining 26 are UNKNOWN for exact SKU scoring. The allowed IDs below are the observed, corroborated IDs. Catalog completeness is unknown.

| Row | Manufacturer requirement | Reviewed VI IDs |
|---|---|---|
| 3 | [HOEGERT HT1W804](https://shop.hoegert.com/en/products/hex-keys-with-ball-end-crv-9-pcs), ball-end CrV, 1.5–10 mm, nine pieces | 1786499, 1844126 |
| 11 | [Makita DTW285Z](https://makita-groupe.fr/makita/page.php?REF=DTW285Z&rub=fiche&s_rub=s_categories_2_4), cordless impact wrench, bare tool | 932430 |
| 14 | [HOEGERT HT1R007](https://shop.hoegert.com/products/klucz-plasko-oczkowy-z-grzechotka-ze-stali-crv-7-mm-72t), 7 mm, CrV, 72 teeth | 1985803 |
| 55 | [Wera 190 i VDE](https://www.wera.de/en/tools/190-i-vde-insulated-nutdriver), 6×125 mm, 05005305001 | 530604 |

Specifications come from manufacturers. Catalog IDs were mapped after discovery and were withheld from C. A/B historical data and C live data were kept separate from the post-run crosswalk. A manufacturer catalog supports a clarification on row 2, because ПГР-70 and its variants do not settle the requested spelling ПРГ-70. [КВТ](https://www.kvt.tools/shop/crimpers/hdcrimp/)

Explicit negatives include Makita KIT034 for DTW285Z, other brands for the specified AEG, wrong-brand or wrong-size ratchets for the 7 mm HOEGERT, and pointed screws for a request for a drill point. Unclear series and revised part numbers stay UNKNOWN pending evidence. No customer material or raw logs are published.
