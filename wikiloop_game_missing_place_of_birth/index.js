// Copyright 2019 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const Koa = require('koa');
const Knex = require('knex');
const jsonp = require('koa-response-jsonp');
const rp = require('request-promise');
const app = new Koa();

app.proxy = true;

const db = process.env.SQL_DATABASE;
const metaDB = process.env.METADATABASE;
const knex = connect();

jsonp(app);

function connect() {
  const config = {
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    database: db,
  };

  if (
    process.env.INSTANCE_CONNECTION_NAME &&
    process.env.NODE_ENV === 'production'
  ) {
    config.socketPath = `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}`;
  }

  // Connect to the database
  const knex = Knex({
    client: 'mysql',
    connection: config,
  });

  return knex;
}

var returned = new Set();
let tablename = '';

// Get the newest epoch
async function getNewestEpoch() {
	let result = await knex
	.withSchema(metaDB)
	.from(db + 'epoch')
	.orderBy('epoch', 'desc');
	return result[0];
}

async function getRows(num, lang) {
	let checked = await knex.select('qNumber').from(tablename + '_logging');
	checked = checked.map(r => r.qNumber);
	let showed = [...new Set([...checked, ...returned])];
	// Check primary language first, if no records, return regular query results.
  let res = await knex(tablename)
			.whereNotIn('qNumber', showed)
			.andWhere('languages', 'like', '%' + lang + '%')
			.limit(num * 5);
	if (res.length === 0) {
		return knex(tablename)
			.whereNotIn('qNumber', showed)
			.andWhereNot('languages', 'like', '%' + lang + '%')
			.limit(num * 5)
	}else {
		return res;
	}
}

async function getWikidataClaims(qNumber) {
	let options = {
	    uri: 'https://www.wikidata.org/w/api.php',
	    qs: {
	        action: 'wbgetclaims', 
	        format: 'json',
	        entity: qNumber,
	        property: 'P19'
	    },
	    headers: {
	        'User-Agent': 'Request-Promise'
	    },
	    json: true
	};
	let claims = [];
	let reg = new RegExp('[0-9-]+');
	// Before show data, query wikidata database to see if the target claim exist or not
	await rp(options).then(res =>{
		if (res.claims && res.claims.hasOwnProperty('P19')) {
				claims.push(...res.claims.P19)
			}
		}
	)
	return claims;
}

async function updateLoggindTable(q) {
	let currentTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
	// In minor case, one user could act on the same entity twice, eg. from differnt epoch
	// For each user&item pair, we only store the newest movement
	let data = {user: q.user, qNumber: q.tile, decision: q.decision, changetime: currentTime};
	let insertEpochTableQuery = knex(tablename + '_logging').insert(data).toString();
	insertEpochTableQuery += ' on duplicate key update ' + knex.raw('changetime = ?, decision = ? ', [currentTime, q.decision]);
	await knex.raw(insertEpochTableQuery);
	let insertAllTableQuery = knex('all_logging_history').insert(data).toString();
	insertAllTableQuery += ' on duplicate key update ' + knex.raw('changetime = ?, decision = ? ', [currentTime, q.decision]);
	await knex.raw(insertAllTableQuery);
}

// Extract language abbreviate from wikipedia url
function getUrlLanguage(url) {
  // Chinese Wikipedia only take zh-cn
  let lang = url.replace(/^http:\/\//, "");
  return lang.replace(/\.wikipedia.*$/, "");
}

function generateDisplayData(row) {
	let sections = [];
	let entries = [];
	let qNumber = row.qNumber;
	// wikidata item section
	sections.push({type: 'item', q: qNumber});
	// missing value section
	let valueSection = {
		type: 'html',
		title: 'Was this person born here:'	
	};
	sections.push(valueSection);	
	targetID = row.missingValue.replace('http://www.wikidata.org/wiki/', '');
	sections.push({type: 'item', q: targetID});
	// wikipedia refernce url section
	// Store Html format text in the reference section on UI
	let refUrlsHtml = '';
  // the references for the claim that will be added
	let referenceSnaks = [];
  let refUrls = row.refs.split(', ');
  refUrls.forEach(u => {
  	let lang = getUrlLanguage(u)
		if (refUrlsHtml.length !== 0) {
			refUrlsHtml += '<br>';
		}  	
		refUrlsHtml += `<a href="${u}" target="_blank">${lang.toUpperCase()} Wikipedia</a>`;
		referenceSnaks.push(generateRefSnaks(u));
  })	
	sections.push({type: 'html', title: 'References:', text: refUrlsHtml});
	entries.push(generateYesEntry(row.missingValue, referenceSnaks, qNumber));
	entries.push({type: 'white', decision: 'skip', label: 'I don\'t know'});
	entries.push({type: 'blue', decision: 'no', label: 'Reject'});
	return [sections, entries];
}

function generateYesEntry(missingValue, referenceSnaks, qNumber){
	let api_action = {};
	// prepare the action through wbeditentity API
	// wbcreateclaim API can't do create cliam and add reference at the same time
	api_action.action = 'wbeditentity';
	api_action.id = qNumber;
	api_action.summary = 'Distributed game missing place of birth. Update P19.';
	let data = {};
	data.claims = [];
	let claim = {};
	let targetId = parseInt(missingValue.replace('http://www.wikidata.org/wiki/Q', ''));
	claim.mainsnak = {
		snaktype: 'value',
		property: 'P19',
		datavalue: {
			// Default to gregorian calendar cause we only process date after 1800
			value: {
				'entity-type': 'item',
				'numeric-id': targetId
			},
			type: 'wikibase-entityid'
		},
		datatype: "wikibase-item",
	};
	claim.references = [];
	claim.references.push({
    snaks: {
      P4656: referenceSnaks
    },
    'snacks-order': ['P4656']
  });
	claim.type = 'statement';		
	claim.rank = 'normal';
	data.claims.push(claim);
	api_action.data = JSON.stringify(data);
	let entry = {
		type: 'green',
		decision: 'yes',
		label: 'Accept',
		api_action: api_action
	}
	return entry;
}

function generateRefSnaks(url){
  // P4656 is Wikimedia import URL, indicates this data is imported from other wikimedia
  return {
    snaktype: "value",
    property: 'P4656',
    datavalue: {
      value: url,
      type: 'string'
    },
    datatype: 'url'
	};
}

app.use(async (ctx, next) => {
  const q = ctx.query;
  const out = {};
	let newestEpoch = await getNewestEpoch();
	tablename = db + '_' + newestEpoch.epoch;
  if (q.action == 'desc') {
  	out.label = {en: 'Born where'};
  	out.description = {en: "Import missing place of birth from wikipedia to wikidata."};
  	out.instructions = {en: "*Click \"Accept\" to add a [https://www.wikidata.org/wiki/Property:P19 place of birth(P19)] claim to the wikidata entity, meanwhile add the source wikipedia links to [https://www.wikidata.org/wiki/Property:P4656 Wikimedia import URL] in the claim reference part.\n" + 
  	"*Click \"Reject\" if the place of birth suggestion appears to be wrong.\n*If you are not sure of what to do, click \"I don't know\".\n" + 
  	"*Be sure to verify the suggested birth place using the links presented." + 
		"*Tiles contains a source wikipedia link in your primary language (the first language in your user settings) will be shown first, " +
		"other tiles are displayed when all tiles in your primary language have been marked.\n" +
  	"*Bug reports and feedback should be sent to [https://www.wikidata.org/wiki/User:Chaoyuel User:Chaoyuel] or [https://github.com/google/wikiloop-wikidata-game Github].\n" +
		`*Data was last collected on ${newestEpoch.epoch}.`};
  	out.icon = 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/37/BlankMap-World-820.png/320px-BlankMap-World-820.png';
  	ctx.body = out;
  	ctx.jsonp(out);
  }else if (q.action == 'tiles') {
  	await next();
  } else if (q.action == 'log_action') {
		try {
			await updateLoggindTable(q);
		}catch(err) {
			console.log(err);
		}
		out.status = 'logging info';
		ctx.body = out;
  	ctx.jsonp(out); 
  } else {
  	out.status = 'No valid action!';
  	ctx.jsonp(out);
  }
});

app.use(async ctx => {
	const q = ctx.query;
	const num = q.num;
	const lang = q.lang;
	let out = {};
	out.tiles = [];
	while(out.tiles.length < num) {
		let rows;
		try {
			rows = await getRows(num, lang);
		}catch(err) {
			console.log(err);
		}
		let i = 0;
		if (rows.length === 0) {
			break;
		}
		while (out.tiles.length < num && i < rows.length) {
			const row = rows[i++];
			let qNumber = row.qNumber;
			//Check the q entity is not returned.
			if (returned.has(qNumber)) {
				continue;
			}
			returned.add(qNumber);
			// Query wikidata database to check the claim status before output
			let claims = await getWikidataClaims(qNumber);
			// Skip the entities that already have place of birth claim
			if (claims.length >= 1) {
				continue;
			}
			let values = generateDisplayData(row);
			const tile = {
				id: qNumber,
				sections: values[0],
				controls: [{
					type: 'buttons',
					entries: values[1],
				}]
			};
			out.tiles.push(tile);
		}
	}
	ctx.body = out;
	ctx.jsonp(out);
});

app.listen(8080);
