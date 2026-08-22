# Derivation report

Run: 2026-08-22T19:49:00.843Z · 337,487 jobs in 197.8s
FX rates as of **2026-08** (static — see `src/lib/derive/salary.mjs`)

## Coverage

| Signal | Jobs | Share |
| --- | --- | --- |
| workplace known | 329,831 | 97.7% |
| placed in ≥1 metro | 294,778 | 87.3% |
| in >1 metro | 109,106 | 32.3% |
| salary in USD/yr | 87,168 | 25.8% |
| years of experience parsed | 191,983 | 56.9% |
| seniority classified | 243,450 | 72.1% |
| visa: sponsors | 1,858 | 0.6% |
| visa: explicitly not | 17,196 | 5.1% |
| security clearance | 11,333 | 3.4% |
| mean listing quality | 0.74 | of 1.00 |

## Workplace

| Value | Jobs | Share |
| --- | --- | --- |
| onsite | 228,751 | 67.8% |
| remote | 71,094 | 21.1% |
| hybrid | 29,986 | 8.9% |
| unknown | 7,656 | 2.3% |

## Seniority

| Value | Jobs | Share |
| --- | --- | --- |
| unknown | 94,037 | 27.9% |
| senior | 61,793 | 18.3% |
| entry | 42,889 | 12.7% |
| mid | 41,180 | 12.2% |
| manager | 34,686 | 10.3% |
| director | 18,088 | 5.4% |
| junior | 17,012 | 5.0% |
| staff | 12,495 | 3.7% |
| executive | 6,813 | 2.0% |
| intern | 4,374 | 1.3% |
| principal | 4,120 | 1.2% |

## Job function

| Value | Jobs | Share |
| --- | --- | --- |
| other | 65,041 | 19.3% |
| engineering | 62,882 | 18.6% |
| sales | 39,960 | 11.8% |
| operations | 30,157 | 8.9% |
| healthcare | 24,184 | 7.2% |
| marketing | 18,149 | 5.4% |
| customer-success | 16,709 | 5.0% |
| data | 10,059 | 3.0% |
| finance | 9,730 | 2.9% |
| logistics | 7,842 | 2.3% |
| people | 7,082 | 2.1% |
| design | 6,081 | 1.8% |
| product | 5,418 | 1.6% |
| security | 5,208 | 1.5% |
| manufacturing | 4,761 | 1.4% |
| legal | 3,944 | 1.2% |
| research | 3,696 | 1.1% |
| retail | 3,593 | 1.1% |
| education | 3,503 | 1.0% |
| construction | 3,188 | 0.9% |
| it | 2,621 | 0.8% |
| hospitality | 2,195 | 0.7% |
| media | 1,364 | 0.4% |
| science | 120 | 0.0% |

## Salary parse outcome

| Value | Jobs | Share |
| --- | --- | --- |
| no-figure | 250,022 | 74.1% |
| as-stated | 77,046 | 22.8% |
| reinterpreted | 10,122 | 3.0% |
| implausible | 257 | 0.1% |
| unknown-currency | 40 | 0.0% |

## Degree requirement

| Value | Jobs | Share |
| --- | --- | --- |
| bachelors | 55,160 | 16.3% |
| masters | 39,742 | 11.8% |
| none | 22,438 | 6.6% |
| phd | 12,215 | 3.6% |

## Metros

24,576 distinct metros, of which 24,532 were minted from city names not in the curated table.

| Metro | Jobs |
| --- | --- |
| sf-bay | 31,615 |
| nyc | 27,598 |
| london | 16,243 |
| dc | 11,095 |
| la | 9,587 |
| boston | 7,237 |
| seattle | 5,949 |
| chicago | 5,435 |
| austin | 5,358 |
| dallas | 5,138 |
| svetness-personal-training | 4,985 |
| toronto | 4,498 |
| bangalore | 4,098 |
| denver | 3,791 |
| singapore | 3,771 |
| berlin | 3,618 |
| phoenix | 3,617 |
| atlanta | 3,273 |
| paris | 3,080 |
| field | 2,985 |
| sao-paulo | 2,706 |
| manchester | 2,669 |
| miami | 2,433 |
| houston | 2,290 |
| munich | 2,190 |
| seoul | 1,932 |
| tokyo | 1,858 |
| hong-kong | 1,858 |
| amsterdam | 1,846 |
| san-diego | 1,769 |

## Unmatched location fragments

Fragments that produced no metro. Each is a candidate alias — adding it to
`METRO_GROUPS` and re-running costs seconds and needs no re-sweep.

| Fragment | Occurrences |
| --- | --- |
| `222 grays inn rd` | 1,874 |
| `wc1x 8hb` | 1,874 |
| `57 spring gardens` | 1,870 |
| `m2 2by` | 1,870 |
| `ca oc-00` | 1,260 |
| `sp` | 614 |
| `great cambridge road` | 471 |
| `en10 6nh` | 471 |
| `ny-licensed behavior analyst professional services` | 341 |
| `orchard road` | 209 |
| `10025` | 203 |
| `mountain view us-mtv-emf680` | 182 |
| `c6 bank` | 166 |
| `sioux center` | 161 |
| `multiple locations` | 156 |
| `global operations center` | 148 |
| `san francisco us-sfo-mkt555` | 141 |
| `rl` | 131 |
| `190 tasman` | 127 |
| `zone 1 job requisitions` | 125 |
| `us > arizona > phoenix` | 122 |
| `mg` | 114 |
| `mountain view us-mtv-emf690` | 100 |
| `pangyo software dream center` | 97 |
| `oh arsenal 1` | 97 |
| `ca oc-62` | 96 |
| `dc 999` | 92 |
| `tbd` | 91 |
| `225 s aviation` | 90 |
| `az phoenix asm america inc` | 85 |
| `عمّان` | 84 |
| `110 5th ave` | 82 |
| `ih` | 80 |
| `forrlibuckstrasse 190` | 80 |
| `8005 zurich` | 80 |
| `auckland production complex` | 80 |
| `λευκωσια` | 79 |
| `suite 100` | 78 |
| `the river building` | 76 |
| `various locations` | 75 |

## Also written

- `job_metros`: 473,281 rows
- `job_skills`: 659,404 rows
- `metro_aliases`: 25,113 rows
- company display names filled from slug: 2,611
- full-text documents indexed: 337,487
