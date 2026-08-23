# Derivation report

Run: 2026-08-23T15:14:15.464Z · 5,686 jobs in 238.1s
FX rates as of **2026-08** (static — see `src/lib/derive/salary.mjs`)

## Coverage

| Signal | Jobs | Share |
| --- | --- | --- |
| workplace known | 5,605 | 98.6% |
| placed in ≥1 metro | 4,809 | 84.6% |
| in >1 metro | 1,351 | 23.8% |
| salary in USD/yr | 2,015 | 35.4% |
| years of experience parsed | 3,295 | 57.9% |
| seniority classified | 4,439 | 78.1% |
| visa: sponsors | 81 | 1.4% |
| visa: explicitly not | 192 | 3.4% |
| security clearance | 89 | 1.6% |
| mean listing quality | 0.83 | of 1.00 |

## Workplace

| Value | Jobs | Share |
| --- | --- | --- |
| onsite | 2,395 | 42.1% |
| remote | 1,971 | 34.7% |
| hybrid | 1,239 | 21.8% |
| unknown | 81 | 1.4% |

## Seniority

| Value | Jobs | Share |
| --- | --- | --- |
| unknown | 1,247 | 21.9% |
| senior | 1,182 | 20.8% |
| mid | 942 | 16.6% |
| manager | 565 | 9.9% |
| entry | 470 | 8.3% |
| director | 362 | 6.4% |
| junior | 310 | 5.5% |
| staff | 307 | 5.4% |
| executive | 143 | 2.5% |
| intern | 94 | 1.7% |
| principal | 64 | 1.1% |

## Job function

| Value | Jobs | Share |
| --- | --- | --- |
| engineering | 1,410 | 24.8% |
| sales | 726 | 12.8% |
| other | 541 | 9.5% |
| marketing | 485 | 8.5% |
| operations | 417 | 7.3% |
| customer-success | 399 | 7.0% |
| healthcare | 348 | 6.1% |
| data | 190 | 3.3% |
| people | 189 | 3.3% |
| finance | 176 | 3.1% |
| design | 143 | 2.5% |
| product | 134 | 2.4% |
| manufacturing | 79 | 1.4% |
| legal | 75 | 1.3% |
| research | 74 | 1.3% |
| security | 69 | 1.2% |
| logistics | 60 | 1.1% |
| it | 55 | 1.0% |
| construction | 43 | 0.8% |
| media | 22 | 0.4% |
| education | 22 | 0.4% |
| retail | 19 | 0.3% |
| hospitality | 6 | 0.1% |
| science | 4 | 0.1% |

## Salary parse outcome

| Value | Jobs | Share |
| --- | --- | --- |
| no-figure | 3,668 | 64.5% |
| as-stated | 1,975 | 34.7% |
| reinterpreted | 40 | 0.7% |
| implausible | 2 | 0.0% |
| unknown-currency | 1 | 0.0% |

## Degree requirement

| Value | Jobs | Share |
| --- | --- | --- |
| bachelors | 588 | 10.3% |
| masters | 423 | 7.4% |
| phd | 388 | 6.8% |
| none | 102 | 1.8% |

## Metros

1,408 distinct metros, of which 1,350 were minted from city names not in the curated table.

| Metro | Jobs |
| --- | --- |
| sf-bay | 831 |
| nyc | 563 |
| london | 358 |
| austin | 292 |
| berlin | 160 |
| dc | 141 |
| boston | 131 |
| la | 113 |
| seattle | 100 |
| munich | 95 |
| denver | 86 |
| toronto | 82 |
| paris | 76 |
| dallas | 73 |
| bangalore | 69 |
| chicago | 60 |
| tel-aviv | 58 |
| san-francisco-bay | 56 |
| singapore | 53 |
| mexico-city | 51 |
| manila | 47 |
| seoul | 45 |
| atlanta | 44 |
| cairo | 43 |
| miami | 42 |
| amsterdam | 41 |
| phoenix | 41 |
| san-diego | 40 |
| houston | 38 |
| johannesburg | 34 |

## Unmatched location fragments

Fragments that produced no metro. Each is a candidate alias — adding it to
`METRO_GROUPS` and re-running costs seconds and needs no re-sweep.

| Fragment | Occurrences |
| --- | --- |
| `arco business services 006` | 25 |
| `commonwealth of the northern mariana islands` | 20 |
| `the river building` | 18 |
| `santa cruz de la sierra` | 17 |
| `purkynova 2121` | 14 |
| `3` | 14 |
| `110 00 nove mesto` | 14 |
| `tbd` | 11 |
| `nz: auckland: xero 4 96 st georges bay rd` | 7 |
| `level 2 & 3` | 7 |
| `1 ferry building` | 7 |
| `ca 94111` | 7 |
| `ny 3 days` | 6 |
| `2889 w 5th st` | 6 |
| `las vegas: n lamb blvd & e charleston blvd` | 6 |
| `orchard road` | 4 |
| `ct 06511` | 4 |
| `basingstoke rg22 4sb` | 4 |
| `835 industrial road` | 4 |
| `arco national 005` | 4 |
| `794 dixwell avenue` | 3 |
| `au: melbourne: 260 burwood rd` | 3 |
| `au: sydney 45 clarence st` | 3 |
| `amn norcal 080` | 3 |
| `306 circular ave` | 2 |
| `ct 06514` | 2 |
| `270-222 islington ave 2nd floor` | 2 |
| `entrance #3` | 2 |
| `85748` | 2 |
| `sitio 2nd floor rua do conde` | 2 |
| `redondo 145 1150-294 lisbon` | 2 |
| `newton centre` | 2 |
| `14th street` | 2 |
| `1 oxford st` | 2 |
| `nz: wellington: xero one 19-23 taranaki st` | 2 |
| `us: san mateo 1875 south grant street` | 2 |
| `global excl jp` | 2 |
| `anc new england 082` | 2 |
| `anc kansas city 018` | 2 |
| `ca oc-00` | 2 |

## Also written

- `job_metros`: 481,755 rows
- `job_skills`: 672,555 rows
- `metro_aliases`: 1,667 rows
- company display names filled from slug: 10
- full-text documents indexed: 343,173
