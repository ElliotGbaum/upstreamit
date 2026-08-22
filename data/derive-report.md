# Derivation report

Run: 2026-08-22T04:33:43.854Z · 61,213 jobs in 31.1s
FX rates as of **2026-08** (static — see `src/lib/derive/salary.mjs`)

## Coverage

| Signal | Jobs | Share |
| --- | --- | --- |
| workplace known | 60,558 | 98.9% |
| placed in ≥1 metro | 51,497 | 84.1% |
| in >1 metro | 13,458 | 22.0% |
| salary in USD/yr | 22,773 | 37.2% |
| years of experience parsed | 34,193 | 55.9% |
| seniority classified | 45,987 | 75.1% |
| visa: sponsors | 534 | 0.9% |
| visa: explicitly not | 1,437 | 2.3% |
| security clearance | 896 | 1.5% |
| mean listing quality | 0.85 | of 1.00 |

## Workplace

| Value | Jobs | Share |
| --- | --- | --- |
| onsite | 27,118 | 44.3% |
| remote | 17,508 | 28.6% |
| hybrid | 15,932 | 26.0% |
| unknown | 655 | 1.1% |

## Seniority

| Value | Jobs | Share |
| --- | --- | --- |
| unknown | 15,226 | 24.9% |
| senior | 13,892 | 22.7% |
| mid | 9,262 | 15.1% |
| manager | 5,583 | 9.1% |
| entry | 3,766 | 6.2% |
| director | 3,668 | 6.0% |
| staff | 3,515 | 5.7% |
| junior | 3,030 | 4.9% |
| executive | 1,608 | 2.6% |
| intern | 915 | 1.5% |
| principal | 748 | 1.2% |

## Job function

| Value | Jobs | Share |
| --- | --- | --- |
| engineering | 17,469 | 28.5% |
| sales | 8,761 | 14.3% |
| marketing | 4,874 | 8.0% |
| customer-success | 4,367 | 7.1% |
| operations | 4,340 | 7.1% |
| other | 4,338 | 7.1% |
| data | 2,629 | 4.3% |
| healthcare | 2,380 | 3.9% |
| finance | 1,939 | 3.2% |
| product | 1,663 | 2.7% |
| design | 1,639 | 2.7% |
| people | 1,523 | 2.5% |
| security | 1,108 | 1.8% |
| research | 1,059 | 1.7% |
| legal | 664 | 1.1% |
| manufacturing | 533 | 0.9% |
| logistics | 521 | 0.9% |
| it | 410 | 0.7% |
| construction | 312 | 0.5% |
| education | 288 | 0.5% |
| media | 184 | 0.3% |
| retail | 139 | 0.2% |
| science | 37 | 0.1% |
| hospitality | 36 | 0.1% |

## Salary parse outcome

| Value | Jobs | Share |
| --- | --- | --- |
| no-figure | 38,412 | 62.8% |
| as-stated | 22,577 | 36.9% |
| reinterpreted | 196 | 0.3% |
| implausible | 20 | 0.0% |
| unknown-currency | 8 | 0.0% |

## Degree requirement

| Value | Jobs | Share |
| --- | --- | --- |
| bachelors | 6,438 | 10.5% |
| masters | 5,557 | 9.1% |
| phd | 2,216 | 3.6% |
| none | 744 | 1.2% |

## Metros

3,178 distinct metros, of which 3,127 were minted from city names not in the curated table.

| Metro | Jobs |
| --- | --- |
| sf-bay | 13,111 |
| nyc | 8,702 |
| london | 4,011 |
| austin | 1,636 |
| la | 1,529 |
| berlin | 1,472 |
| boston | 1,343 |
| seattle | 1,335 |
| dc | 1,230 |
| toronto | 1,182 |
| paris | 1,102 |
| munich | 929 |
| singapore | 854 |
| denver | 617 |
| chicago | 606 |
| dallas | 587 |
| bangalore | 576 |
| warsaw | 551 |
| atlanta | 478 |
| barcelona | 458 |
| tokyo | 437 |
| amsterdam | 420 |
| sydney | 411 |
| stuttgart | 394 |
| san-francisco-bay | 392 |
| kyiv | 364 |
| montreal | 363 |
| mexico-city | 358 |
| miami | 355 |
| stockholm | 337 |

## Unmatched location fragments

Fragments that produced no metro. Each is a candidate alias — adding it to
`METRO_GROUPS` and re-running costs seconds and needs no re-sweep.

| Fragment | Occurrences |
| --- | --- |
| `orchard road` | 208 |
| `pangyo software dream center` | 97 |
| `the river building` | 76 |
| `408 broadway` | 54 |
| `floor 5` | 54 |
| `3` | 53 |
| `purkynova 2121` | 43 |
| `110 00 nove mesto` | 43 |
| `300 montgomery st suite 500 san francisco` | 42 |
| `california 94104` | 42 |
| `ny 3 days` | 34 |
| `au: melbourne: 260 burwood rd` | 33 |
| `santa cruz de la sierra` | 32 |
| `stuttgart schockenriedstr 17` | 31 |
| `federal territory of kuala lumpur` | 30 |
| `au: sydney 45 clarence st` | 28 |
| `*` | 25 |
| `data center` | 25 |
| `720 university ave` | 22 |
| `suite 200` | 22 |
| `ca 94301` | 22 |
| `df` | 20 |
| `old street` | 20 |
| `bonifacio global city` | 20 |
| `2889 w 5th st` | 16 |
| `ct 06511` | 15 |
| `san francisco bay san mateo` | 15 |
| `1425 ellsworth industrial blvd nw #5` | 14 |
| `ga 30318` | 14 |
| `835 industrial road` | 14 |
| `can: vancouver 333 seymour st` | 14 |
| `tn y-12` | 13 |
| `full-time` | 13 |
| `nz: auckland: xero 4 96 st georges bay rd` | 13 |
| `level 2 & 3` | 13 |
| `san mateo san francisco bay` | 12 |
| `#1 145 5ht main road` | 12 |
| `sector 6th` | 12 |
| `munzstraße 21` | 12 |
| `2 etage 10178 berlin` | 12 |

## Also written

- `job_metros`: 76,041 rows
- `job_skills`: 161,350 rows
- `metro_aliases`: 3,461 rows
- company display names filled from slug: 0
- full-text documents indexed: 61,213
