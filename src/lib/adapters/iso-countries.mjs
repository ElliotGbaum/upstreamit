/**
 * ISO 3166-1 alpha-2 → English country name, for the ATSes that publish a code
 * rather than a place.
 *
 * ## Why this is not a one-line lookup table sitting inside one adapter
 *
 * Lever publishes `country: "DE"` on 99.2% of its jobs, and the obvious move —
 * storing that string in `jobs.country` — is wrong on 17.5% of them. Everything
 * a job says about where it is ends up in `deriveLocation`, which runs each
 * fragment through `parseFragment`. That parser's alias table is built for
 * location *strings*, where a bare two-letter token is overwhelmingly a US state
 * or a Canadian province: "San Francisco, CA" is California, not Canada. So it
 * resolves the ISO code the same way, and on a 8,697-job Lever corpus that put
 *
 *   DE →  us  (Delaware, not Germany)      805 jobs
 *   CA →  us  (California, not Canada)     183
 *   IN →  us  (Indiana, not India)         146
 *   NL →  ca  (Newfoundland, not the       88
 *              Netherlands)
 *   PE →  ca  (Prince Edward Island)        53
 *   CO, IL, AR, ID, SK, PA, MD, MT, PR, SC, AZ, AL  …
 *
 * — 1,521 jobs in the wrong country, most of them tagged United States. The
 * alias table is not at fault; it is right about its own input domain. The bug
 * would be feeding a structured code from a different namespace into a free-text
 * place parser and expecting it to know the difference.
 *
 * Expanding the code to its name first removes the ambiguity at the source:
 * "Germany" has exactly one reading. Measured over the same corpus, that takes
 * the mistake count from 1,521 jobs to 2, and it recovers real coverage — the
 * location strings alone yield no country at all on 35.9% of Lever jobs, and the
 * expanded code fills 2,166 of them correctly.
 *
 * ## Why it lives here rather than in `lever.mjs`
 *
 * Same reason as `html.mjs`: Lever is the first ATS in this project to publish
 * an ISO code, not the last. SmartRecruiters, Workable, Recruitee and Personio
 * all do the same, and a second copy of this table is how the two drift.
 *
 * A code this table does not know is returned as `null`, never as the bare code.
 * Falling back to the code would reintroduce exactly the bug above, quietly, for
 * whichever country got left out.
 */

/**
 * The full ISO 3166-1 alpha-2 assignment, in the plain-English form
 * `parseFragment` is most likely to recognise ("South Korea", not "Korea,
 * Republic of"). Deliberately complete rather than trimmed to what today's
 * corpus happens to contain — an unlisted code is a silent NULL, and the whole
 * point of this file is that silent geographic NULLs are hard to notice.
 */
const NAMES = {
  AD: 'Andorra', AE: 'United Arab Emirates', AF: 'Afghanistan', AG: 'Antigua and Barbuda',
  AI: 'Anguilla', AL: 'Albania', AM: 'Armenia', AO: 'Angola', AQ: 'Antarctica',
  AR: 'Argentina', AS: 'American Samoa', AT: 'Austria', AU: 'Australia', AW: 'Aruba',
  AX: 'Åland Islands', AZ: 'Azerbaijan', BA: 'Bosnia and Herzegovina', BB: 'Barbados',
  BD: 'Bangladesh', BE: 'Belgium', BF: 'Burkina Faso', BG: 'Bulgaria', BH: 'Bahrain',
  BI: 'Burundi', BJ: 'Benin', BL: 'Saint Barthélemy', BM: 'Bermuda', BN: 'Brunei',
  BO: 'Bolivia', BQ: 'Caribbean Netherlands', BR: 'Brazil', BS: 'Bahamas', BT: 'Bhutan',
  BV: 'Bouvet Island', BW: 'Botswana', BY: 'Belarus', BZ: 'Belize', CA: 'Canada',
  CC: 'Cocos Islands', CD: 'Democratic Republic of the Congo', CF: 'Central African Republic',
  CG: 'Republic of the Congo', CH: 'Switzerland', CI: 'Ivory Coast', CK: 'Cook Islands',
  CL: 'Chile', CM: 'Cameroon', CN: 'China', CO: 'Colombia', CR: 'Costa Rica', CU: 'Cuba',
  CV: 'Cape Verde', CW: 'Curaçao', CX: 'Christmas Island', CY: 'Cyprus', CZ: 'Czechia',
  DE: 'Germany', DJ: 'Djibouti', DK: 'Denmark', DM: 'Dominica', DO: 'Dominican Republic',
  DZ: 'Algeria', EC: 'Ecuador', EE: 'Estonia', EG: 'Egypt', EH: 'Western Sahara',
  ER: 'Eritrea', ES: 'Spain', ET: 'Ethiopia', FI: 'Finland', FJ: 'Fiji',
  FK: 'Falkland Islands', FM: 'Micronesia', FO: 'Faroe Islands', FR: 'France',
  GA: 'Gabon', GB: 'United Kingdom', GD: 'Grenada', GE: 'Georgia', GF: 'French Guiana',
  GG: 'Guernsey', GH: 'Ghana', GI: 'Gibraltar', GL: 'Greenland', GM: 'Gambia',
  GN: 'Guinea', GP: 'Guadeloupe', GQ: 'Equatorial Guinea', GR: 'Greece',
  GS: 'South Georgia and the South Sandwich Islands', GT: 'Guatemala', GU: 'Guam',
  GW: 'Guinea-Bissau', GY: 'Guyana', HK: 'Hong Kong', HM: 'Heard Island and McDonald Islands',
  HN: 'Honduras', HR: 'Croatia', HT: 'Haiti', HU: 'Hungary', ID: 'Indonesia',
  IE: 'Ireland', IL: 'Israel', IM: 'Isle of Man', IN: 'India',
  IO: 'British Indian Ocean Territory', IQ: 'Iraq', IR: 'Iran', IS: 'Iceland',
  IT: 'Italy', JE: 'Jersey', JM: 'Jamaica', JO: 'Jordan', JP: 'Japan', KE: 'Kenya',
  KG: 'Kyrgyzstan', KH: 'Cambodia', KI: 'Kiribati', KM: 'Comoros',
  KN: 'Saint Kitts and Nevis', KP: 'North Korea', KR: 'South Korea', KW: 'Kuwait',
  KY: 'Cayman Islands', KZ: 'Kazakhstan', LA: 'Laos', LB: 'Lebanon', LC: 'Saint Lucia',
  LI: 'Liechtenstein', LK: 'Sri Lanka', LR: 'Liberia', LS: 'Lesotho', LT: 'Lithuania',
  LU: 'Luxembourg', LV: 'Latvia', LY: 'Libya', MA: 'Morocco', MC: 'Monaco',
  MD: 'Moldova', ME: 'Montenegro', MF: 'Saint Martin', MG: 'Madagascar',
  MH: 'Marshall Islands', MK: 'North Macedonia', ML: 'Mali', MM: 'Myanmar',
  MN: 'Mongolia', MO: 'Macao', MP: 'Northern Mariana Islands', MQ: 'Martinique',
  MR: 'Mauritania', MS: 'Montserrat', MT: 'Malta', MU: 'Mauritius', MV: 'Maldives',
  MW: 'Malawi', MX: 'Mexico', MY: 'Malaysia', MZ: 'Mozambique', NA: 'Namibia',
  NC: 'New Caledonia', NE: 'Niger', NF: 'Norfolk Island', NG: 'Nigeria',
  NI: 'Nicaragua', NL: 'Netherlands', NO: 'Norway', NP: 'Nepal', NR: 'Nauru',
  NU: 'Niue', NZ: 'New Zealand', OM: 'Oman', PA: 'Panama', PE: 'Peru',
  PF: 'French Polynesia', PG: 'Papua New Guinea', PH: 'Philippines', PK: 'Pakistan',
  PL: 'Poland', PM: 'Saint Pierre and Miquelon', PN: 'Pitcairn Islands',
  PR: 'Puerto Rico', PS: 'Palestine', PT: 'Portugal', PW: 'Palau', PY: 'Paraguay',
  QA: 'Qatar', RE: 'Réunion', RO: 'Romania', RS: 'Serbia', RU: 'Russia', RW: 'Rwanda',
  SA: 'Saudi Arabia', SB: 'Solomon Islands', SC: 'Seychelles', SD: 'Sudan',
  SE: 'Sweden', SG: 'Singapore', SH: 'Saint Helena', SI: 'Slovenia',
  SJ: 'Svalbard and Jan Mayen', SK: 'Slovakia', SL: 'Sierra Leone', SM: 'San Marino',
  SN: 'Senegal', SO: 'Somalia', SR: 'Suriname', SS: 'South Sudan',
  ST: 'São Tomé and Príncipe', SV: 'El Salvador', SX: 'Sint Maarten', SY: 'Syria',
  SZ: 'Eswatini', TC: 'Turks and Caicos Islands', TD: 'Chad',
  TF: 'French Southern Territories', TG: 'Togo', TH: 'Thailand', TJ: 'Tajikistan',
  TK: 'Tokelau', TL: 'Timor-Leste', TM: 'Turkmenistan', TN: 'Tunisia', TO: 'Tonga',
  TR: 'Turkey', TT: 'Trinidad and Tobago', TV: 'Tuvalu', TW: 'Taiwan', TZ: 'Tanzania',
  UA: 'Ukraine', UG: 'Uganda', UM: 'United States Minor Outlying Islands',
  US: 'United States', UY: 'Uruguay', UZ: 'Uzbekistan', VA: 'Vatican City',
  VC: 'Saint Vincent and the Grenadines', VE: 'Venezuela', VG: 'British Virgin Islands',
  VI: 'United States Virgin Islands', VN: 'Vietnam', VU: 'Vanuatu',
  WF: 'Wallis and Futuna', WS: 'Samoa', YE: 'Yemen', YT: 'Mayotte',
  ZA: 'South Africa', ZM: 'Zambia', ZW: 'Zimbabwe',
};

/**
 * `"DE"` → `"Germany"`. Anything that is not a recognised alpha-2 code — a name
 * already, an empty string, `"UK"`, junk — returns `null` rather than being
 * passed through. See the header: the fallback is what would be dangerous.
 *
 * @param {unknown} code
 * @returns {string|null}
 */
export function countryName(code) {
  if (typeof code !== 'string') return null;
  const key = code.trim().toUpperCase();
  if (key.length !== 2) return null;
  return NAMES[key] ?? null;
}
