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
const knex = connect();


jsonp(app);

function connect() {
  const config = {
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
		database: db
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
	.withSchema('datasetmetadata')
	.from(db + 'epoch')
	.orderBy('epoch', 'desc');
	return result[0];
}

// Query database
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

// Query wikidata.org api, check whether the missing property exist or not
// TODO: generalize this method, better pass in the property or decide property by database name
async function getWikidataClaims(qNumber) {
	let options = {
	    uri: 'https://www.wikidata.org/w/api.php',
	    qs: {
	        action: 'wbgetclaims', 
	        format: 'json',
	        entity: qNumber,
	        property: 'P570'
	    },
	    headers: {
	        'User-Agent': 'Request-Promise'
	    },
	    json: true
	};
	let claims = [];
	let reg = new RegExp('[0-9-]+');
	await rp(options).then(res =>{
		if (res.claims && res.claims.hasOwnProperty('P570')) {
			for (let p of res.claims.P570) {
				let claim = {};
				claim.id = p.id;
				dt = p.mainsnak.datavalue.value.time.match(reg);
				// process datetime further, get rid of 1990-00-00, 1990-01-00
				// 1990-00-00 -> 1900
				// 1990-01-00 -> 1900-01
				if (d.length > 0){
					let d = dt[0];
					d = d.replace('-00-00', '');
					d = d.replace('-00', '');
					claim.datetime = d;
					claims.push(claim);
				}
			}
		}
	})
	return claims;
}

// Update logging to database
async function updateLoggindTable(q) {
	let currentTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
	// Replace is not supported in knex
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

// The method to generate data, accoridng to the platform format requirement,
// that will be displayed on the game UI.
function generateDisplayData(row) {
	let sections = [];
	let entries = [];
	let qNumber = row.qNumber;
	// wikidata item section
	sections.push({type: 'item', q: qNumber});
	// missing value section
	let valueSection = {
		type: 'html',
		title: 'Possible date of death:',
		text: `<b>${row.missingValue}</b>`
	};
	sections.push(valueSection);
	// wikipedia refernce url section
	// Hold Html format text in the reference section on UI
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
	// actionable button section
	entries.push(generateYesEntry(row.missingValue, referenceSnaks, qNumber));
	entries.push({type: 'white', decision: 'skip', label: 'I don\'t know'});
	entries.push({type: 'blue', decision: 'no', label: 'Reject'});
	return [sections, entries];
}

// Based on the missing value and corresponding property, generate apiAction
function generateYesEntry(missingValue, referenceSnaks, qNumber){
	// If the table is about missing date value, formay the date to what wikidata.org accept
	if (tablename.includes('date')){
		var formattedValue = formatDate(missingValue);
	}
	let apiAction = {};
	// Prepare the action through wbeditentity API
	// This api is the only one could add claim as well as references in one step
	apiAction.action = 'wbeditentity';
	apiAction.id = qNumber;
	// TODO: Submit a bug of the summary is not show right on wikidata.org
	apiAction.summary = 'Distributed game missing date of death. Update P570.';
	let data = {};
	data.claims = [];
	let claim = {};
	// Specific to date value
	// time precision, 11 -> day, 10 -> month, 9 -> year
	// Should have been processed to only output whole precision in previous step.	
	let precision;
	switch(missingValue.length) {
		case 4:
			precision = 9;
			break;
		case 7:
			precision = 10;
			break;
		case 10:
			precision = 11;
			break;
		default:
			precision = 11;
	}
	claim.mainsnak = {
		snaktype: 'value',
		property: 'P570',
		datavalue: {
			// Calendar mode set to Gregorian
			// TODO: what if not set calendar?
			value: {time: formattedValue, timezone: 0, before: 0, after: 0, precision: precision, calendarmodel: "http://www.wikidata.org/entity/Q1985727"},
			type: 'time'
		}
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
	apiAction.data = JSON.stringify(data);
	let entry = {
		type: 'green',
		decision: 'yes',
		label: 'Accept',
		api_action: apiAction
	}
	return entry;
}

// Transfer the date to the format wikidata API accept
function formatDate(date) {
	let res = date;
	switch(date.length) {
		case 4:
			res += '-00-00';
			break;
		case 7:
			res += '-00';
			break;
		default:
			break;
	}
	res = '+' + res + 'T00:00:00Z';
	return res;
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
  	out.label = {en: 'Missing Date of Death'};
  	out.description = {en: "Import missing date of death from wikipedia to wikidata."};
  	out.instructions = {en: "*Click \"Accept\" to add a date of death claim(P570) to the wikidata entity, meanwhile set the wikipedia pages as references.\n" +
  	"*Click \"Reject\" to refuse the suggestion.\n*If you're not sure, click \"I don't know\".\n" +
  	"*The suggested date of death comes from wikipedia articles. There might be error due to outdated wikipedia page snapshots, program parsing error or wrong wikipedia info." +
  	" Be sure to check the data before you make choice!\n" +
		"*The results will prioritize your primary languange (the first language in your user setting).\n" +
		"*Bug reports and feedback should be sent to [https://www.wikidata.org/wiki/User:Chaoyuel User:Chaoyuel].\n" + 
		`*Data were collected until ${newestEpoch.epoch}.`};
  	out.icon = 'https://upload.wikimedia.org/wikipedia/commons/5/56/AngelHeart.png';
		ctx.jsonp(out);
  }else if (q.action == 'tiles') {
  	await next();
  } else if (q.action == 'log_action') {
		try {
			await updateLoggindTable(q);
		}catch(err) {
			console.error(err);
		}
		out.status = 'logging info';
  	ctx.jsonp(out);
  } else {
  	out.status = 'No valid action!';
  	ctx.jsonp(out);
  }
});

app.use(async ctx => {
	let q = ctx.query;
	let num = q.num;
	let lang = q.lang;
	let out = {};
	out.tiles = [];
	while(out.tiles.length < num) {
		let rows;
		try {
			rows = await getRows(num, lang);
		}catch(err) {
			console.error(err);
		}
		let i = 0;
		if (rows.length === 0) {
			break;
		}
		while (out.tiles.length < num && i < rows.length) {
			let row = rows[i++];
			let qNumber = row.qNumber;
			//Check the q entity is not returned.
			if (returned.has(qNumber)) {
				continue;
			}
			returned.add(qNumber);
			let claims = await getWikidataClaims(qNumber);
			// Skip the entities that already have date of death record
			if (claims.length >= 1) {
				continue;
			}
			let values = generateDisplayData(row, claims);
			let tile = {
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
	ctx.jsonp(out);
});

app.listen(8080);
