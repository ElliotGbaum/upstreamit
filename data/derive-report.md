# Derivation report

Run: 2026-08-24T18:06:40.901Z · 2,625 jobs in 436.3s
FX rates as of **2026-08** (static — see `src/lib/derive/salary.mjs`)

## Coverage

| Signal | Jobs | Share |
| --- | --- | --- |
| workplace known | 2,432 | 92.6% |
| placed in ≥1 metro | 2,168 | 82.6% |
| in >1 metro | 883 | 33.6% |
| salary in USD/yr | 566 | 21.6% |
| years of experience parsed | 1,506 | 57.4% |
| seniority classified | 1,988 | 75.7% |
| visa: sponsors | 12 | 0.5% |
| visa: explicitly not | 210 | 8.0% |
| security clearance | 118 | 4.5% |
| mean listing quality | 0.74 | of 1.00 |

## Workplace

| Value | Jobs | Share |
| --- | --- | --- |
| onsite | 1,766 | 67.3% |
| remote | 455 | 17.3% |
| hybrid | 211 | 8.0% |
| unknown | 193 | 7.4% |

## Seniority

| Value | Jobs | Share |
| --- | --- | --- |
| unknown | 637 | 24.3% |
| senior | 482 | 18.4% |
| mid | 422 | 16.1% |
| entry | 280 | 10.7% |
| manager | 250 | 9.5% |
| junior | 194 | 7.4% |
| director | 144 | 5.5% |
| intern | 73 | 2.8% |
| staff | 71 | 2.7% |
| principal | 38 | 1.4% |
| executive | 34 | 1.3% |

## Job function

| Value | Jobs | Share |
| --- | --- | --- |
| engineering | 501 | 19.1% |
| other | 392 | 14.9% |
| sales | 323 | 12.3% |
| operations | 199 | 7.6% |
| customer-success | 180 | 6.9% |
| marketing | 148 | 5.6% |
| construction | 125 | 4.8% |
| product | 86 | 3.3% |
| finance | 80 | 3.0% |
| data | 77 | 2.9% |
| healthcare | 64 | 2.4% |
| security | 64 | 2.4% |
| people | 60 | 2.3% |
| design | 60 | 2.3% |
| education | 42 | 1.6% |
| manufacturing | 37 | 1.4% |
| research | 37 | 1.4% |
| logistics | 35 | 1.3% |
| hospitality | 33 | 1.3% |
| it | 32 | 1.2% |
| legal | 30 | 1.1% |
| retail | 8 | 0.3% |
| science | 7 | 0.3% |
| media | 5 | 0.2% |

## Salary parse outcome

| Value | Jobs | Share |
| --- | --- | --- |
| no-figure | 2,057 | 78.4% |
| as-stated | 421 | 16.0% |
| reinterpreted | 145 | 5.5% |
| implausible | 2 | 0.1% |

## Degree requirement

| Value | Jobs | Share |
| --- | --- | --- |
| bachelors | 509 | 19.4% |
| masters | 297 | 11.3% |
| none | 94 | 3.6% |
| phd | 62 | 2.4% |

## Metros

930 distinct metros, of which 867 were minted from city names not in the curated table.

| Metro | Jobs |
| --- | --- |
| london | 175 |
| nyc | 149 |
| sf-bay | 122 |
| bangalore | 89 |
| dc | 75 |
| la | 73 |
| arco | 66 |
| murray-national | 66 |
| arco-national-holdings | 60 |
| boston | 51 |
| st-louis | 47 |
| arco-design | 38 |
| build | 38 |
| vienna | 36 |
| chicago | 35 |
| berlin | 35 |
| singapore | 33 |
| seoul | 28 |
| dallas | 28 |
| paris | 27 |
| denver | 26 |
| delhi-ncr | 26 |
| globe | 26 |
| munich | 24 |
| atlanta | 23 |
| austin | 23 |
| seattle | 22 |
| sao-paulo | 21 |
| montreal | 21 |
| redlands | 21 |

## Unmatched location fragments

Fragments that produced no metro. Each is a candidate alias — adding it to
`METRO_GROUPS` and re-running costs seconds and needs no re-sweep.

| Fragment | Occurrences |
| --- | --- |
| `arco national 005` | 19 |
| `222 grays inn rd` | 18 |
| `wc1x 8hb` | 18 |
| `amn ts chicago 048` | 13 |
| `1-800-got-junk?` | 9 |
| `amcc tampa 030` | 9 |
| `anc mc & infrastructure 034` | 8 |
| `prestige dynasty phase 2` | 8 |
| `amn mf chicago 077` | 7 |
| `amn ind chicago 007` | 7 |
| `adb raleigh 095` | 7 |
| `orchard road` | 6 |
| `anc kansas city 018` | 6 |
| `adb philadelphia 008` | 6 |
| `ca oc-00` | 5 |
| `adb new york 085` | 5 |
| `amcc orlando 214` | 5 |
| `amn e&i 207` | 5 |
| `503 broadway` | 5 |
| `ny 10012` | 5 |
| `482 front st w` | 5 |
| `purkynova 2121` | 4 |
| `3` | 4 |
| `110 00 nove mesto` | 4 |
| `anc las vegas 177` | 4 |
| `anc detroit 173` | 4 |
| `anc ohio valley 093` | 4 |
| `anc new england 082` | 4 |
| `amcc fort myers 182` | 4 |
| `amn nashville 078` | 4 |
| `amn sports & ent 232` | 4 |
| `stuttgart schockenriedstr 17` | 3 |
| `broadway academy at mount pleasant` | 3 |
| `sp` | 3 |
| `amn ind minneapolis 238` | 3 |
| `amn austin 235` | 3 |
| `amn laredo 181` | 3 |
| `amn blue ridge 244` | 3 |
| `adb atlanta 003` | 3 |
| `adb baltimore 010` | 3 |

## Also written

- `job_metros`: 482,781 rows
- `job_skills`: 678,630 rows
- `metro_aliases`: 1,213 rows
- company display names filled from slug: 58
- full-text documents indexed: 345,798
