(function(module, realModule, undefined) {

	"use strict";

	var async = require('async'),
	    //path = require("path"),
			//later = require("later"),
			moment = require('moment'),
			marked = require("marked"),
			sanitize = require('google-caja').sanitize,
			// posts = realModule.parent.require('./posts'),
			groups = realModule.parent.require("./groups"),
			user = realModule.parent.require("./user"),
			db = realModule.parent.require('./database'),
			posttools = realModule.parent.require("./postTools"),
			topics = realModule.parent.require("./topics"),
			socket = realModule.parent.require("./socket.io/plugins"),
			websockets = realModule.parent.require("./socket.io"),
			//permissions = require("nodebb-plugin-permissions").permissions,
			notifs = realModule.parent.require('./notifications');

			//console.log(permissions);

	function extend(destination, source){
		for (var property in source) {
			if (source[property] && source[property].constructor &&
			source[property].constructor === Object) {
				destination[property] = destination[property] || {};
				extend(destination[property], source[property]);
			} else {
				destination[property] = source[property];
			}
		}
		return destination;
	}

	function getData(callback){
		db.get('plugins:calendar', function(err, data) {
			if(err){
				return callback(err);
			}

			data = JSON.parse(data) || {};

			data.category = data.category || 3;
			data.perms = data.perms || {
				admin: {
					users: {

					},
					groups: {

					}
				},
				editEvents: {
					users: {

					},
					groups: {

					}
				},
				createEvents: {
					users: {

					},
					groups: {

					}
				},
			};
			data.perms.text = data.perms.text || {
				admin: "",
				editEvents: "",
				createEvents: ""
			};

			data.notifications = data.notifications || [];

			data.events = data.events || [];

			callback(null, data);

		});
	}


	function setData(data, callback){
	  db.set('plugins:calendar', JSON.stringify(data), callback);
	}

	module.init = function (app, middleware, controllers, callback) {

		app.get('/calendar', middleware.buildHeader, renderPage);
		app.get('/api/calendar', renderPage);
		app.get('/templates/calendar.tpl', renderPage);

		//app.get("/api/plugins/calendar", renderAPI);
		//app.post('/api/plugins/calendar/save', save);

		app.get('/admin/plugins/calendar', middleware.admin.buildHeader, renderAdmin);
		app.get('/api/admin/plugins/calendar', renderAdmin);

		app.post("/api/admin/plugins/calendar/save", saveAdmin);

		/*
		permissions.register([
			"calendar:event[].edit",
			"calendar:event[].view",
			"calendar:admin",
			"calendar:editEvents",
			"calendar:createEvents"
		]);
		*/

		checkNotifications(callback);

	};

	module.addAdminNavigation = function(header, callback) {

		header.plugins.push({
			route: '/plugins/calendar',
			icon: 'fa-calendar',
			name: 'Calendar configuration'
		});

		callback(null, header);
	};

	function renderAdmin(req, res, next){
		getData(function(err, data) {
			if (err) {
				console.error(err);
				return next(err);
			}

			//console.log(data.perms, data.perms.text);

			data = {
				category: data.category,
				perms: data.perms.text
			};

			//console.log(data);

			res.render("admin/plugins/calendar", data);

		});
	}

	function saveAdmin(req, res, next){

		user.isAdministrator(req.user ? req.user.uid : 0, function(err, bool){
			if(bool){
				var ndata = req.body;

				getData(function(err, data){
					if (err) {
						console.error(err);
						return next(err);
					}

					data.category = ndata.category;
					data.perms.text = ndata.perms;

					var keys = ["admin", "editEvents", "createEvents"];
					var perms = {
						admin: {
							users: {},
							groups: {}
						},
						editEvents: {
							users: {},
							groups: {}
						},
						createEvents: {
							users: {},
							groups: {}
						},
					};

					async.map(keys, function(key, nxt){
						parsePerms(data.perms.text[key], function(obj){
							perms[key] = obj;
							nxt(null, obj);
						});
					}, function(err, result){
						data.perms = perms;
						data.perms.text = ndata.perms;

						setData(data, function(err){
							err ? res.json(500, 'Error while saving') : res.json('Successfully saved');
						});

					});

				});
			}
		});

	}

	module.setWidgetAreas = function(areas, callback) {
		areas = areas.concat([
			{
				'name': 'Calendar Footer',
				'template': 'calendar',
				'location': 'footer'
			}
		]);

		callback(null, areas);
	};

	module.addNavigation = function(header, callback) {
		header.navigation.push({
			"class": "calendar",
			"route": "/calendar",
			"name": "Calendar",
			"title": "Calendar",
			text: '<i class="fa fa-fw fa-calendar"></i><span class="visible-xs-inline"> Calendar</span>'
		});

		callback(null, header);
	};

	function render (route, res, next, req) {
		getData(function(err, data) {
			if (err) {
				console.error(err);
				return next(err);
			}

			//console.log(req);

			reduce(req.user ? req.user.uid : 0, data.events, function(ndata, thisuser, err){

				if(err){
					console.error(err);
					return next(err);
				}

				ndata = {
					events: JSON.stringify(ndata),
					canCreate: false
				};
				
				if(thisuser.perms.createEvents || thisuser.perms.editEvents || thisuser.admin || thisuser.perms.admin){
					ndata.canCreate = true;
				}

				//console.log(ndata);

				res.render(route, ndata);

			});

		});
	}

	function renderPage(req, res, next){
		render("calendar", res, next, req);
	}

	function renderAPI(req, res, next){
		render("plugins/calendar", res, next, req);
	}

	socket.calendar = {

		saveEvent: function(socket, event, callback){

			getData(function(err, oData){

				if(err){
					socket.emit('calendar.error.save', {
						error: "calendar.database.fail",
						data: err
					});
					return; callback();
				}

				console.log("recieved new data: ", event);

				merge(socket.uid, oData.events, event, function(err, ndata, thisuser, newd){

					if(err){
						return socket.emit('calendar.error.save', {
							error: err,
							data: ndata
						});
						return; callback();
					}

					console.log("saving new data: \n", newd);

					oData.events = ndata;

					setData( oData, function(err) {
						if(err){
							socket.emit('calendar.error.save', {
								error: "calendar.database.fail",
								data: err
							});
						} else {
							websockets.server.sockets.in("calendar").emit('calendar.event.updated', newd);
							callback(null, newd);
						}
					});
				});

			});

		},

		deleteEvent: function(socket, event, callback){

			getData(function(err, oData){

				if(err){
					socket.emit('calendar.error.delete', {
						error: "calendar.database.fail",
						data: err
					});
					return callback();
				}

				var oevents = oData.events;

				getUser(socket.uid, function(thisuser){

					if((event.oldId || event.oldId === 0) &&
						event.id === -1 &&
						(thisuser.perms.admin ||
							thisuser.admin ||
							oevents[event.oldId].user.cid == socket.uid)){

						posttools.delete(oevents[event.oldId].user.cid, oevents[event.oldId].pid, function(){ });

						console.log("deleting event: " + event.name );

						oevents[event.oldId] = undefined;

						oData.events = oevents;

						setData(oData, function(err){

							if(err){
								socket.emit('calendar.error.delete', {
									error: "calendar.database.fail",
									data: err
								});
								return callback();
							}

							websockets.server.sockets.in("calendar").emit("calendar.event.deleted", event.oldId);
							return callback(null, event.oldId);
						});

					} else if(!(thisuser.perms.admin ||
						thisuser.admin ||
						oevents[event.oldId].user.cid == socket.uid)){
						socket.emit("calendar.error.delete", {
							error: "calendar.permissions.unauthorized"
						});
					} else {
						socket.emit("calendar.error.delete", {
							error: "calendar.error.unknown"
						});
					}

				});

			});
		}
	};

	function niceDate(event){
		var start = {utc: moment.utc(event.startdate), yours: moment(event.startdate)},
			end = {utc: moment.utc(event.enddate), yours: moment(event.enddate)};

		var utc, yours,
			datedate = "DD MMM YYYY",
			datetimeutc = "DD MMM YYYY H:mm",
			datetime = "DD MMM YYYY h:mm a",
			timetime = "h:mm a",
			timetimeutc = "H:mm";

		if(start.yours.format(datedate) !== end.yours.format(datedate)){
			if(event.allday){
				utc = start.utc.format(datedate) + " - " + end.utc.format(datedate);
				yours = start.yours.format(datedate) + " - " + end.yours.format(datedate);
			} else {
				utc = start.utc.format(datetimeutc) + " - " + end.utc.format(datetimeutc);
				yours = start.yours.format(datetime) + " - " + end.yours.format(datetime);
			}
		} else {
			if(event.allday){
				utc = start.utc.format(datedate);
				yours = start.yours.format(datedate);
			} else {
				utc = start.utc.format(timetimeutc) + " - " + end.utc.format(timetimeutc);
				yours = start.yours.format(timetime) + " - " + end.yours.format(timetime);
			}
		}

		return { utc: utc, yours: yours };
	}

	function makePost(event, callback){
		var url;

		var nice = niceDate(event);

		var content = "### When: \n#### "+nice.utc+" utc \n#### "+nice.yours+" your time" + "\n\n" +
									"### Where: \n"+event.place+" \n\n"+
									"### Description: \n"+event.description + "\n\n"
									;

		getData(function(err, data){
			topics.create({
				uid: event.user.cid,
				cid: data.category,
				title: event.name
			}, function(tid){
				topics.post({
					uid: event.user.cid,
					tid: tid,
					cid: data.category,
					title: event.name,
					content: content
				}, function(err, results){
					url = "/topic/"+results.topicData.slug;
					callback(url, results.postData.pid, results.topicData.tid);
				});
			});
		});


	}

	function updatePost(event, pid, callback){

		var nice = niceDate(event);

		var content = "### When: \n#### "+nice.utc+" utc \n#### "+nice.yours+" your time" + "\n\n" +
									"### Where: \n"+event.place+" \n\n"+
									"### Description: \n"+event.description + "\n\n"
									;

		posttools.edit(event.user.cid, pid, event.name, content, {}, callback);
	}

	function merge(cid, oevents, nevent, callback){

		getUser(cid, function(thisuser){
			var i = nevent.id, event, response = validate(nevent);
			if(!response.passed){
				return callback("calendar.validation.fail", response.errors);
			} else {
				event = response.event;
			}

			event.perms = {};

			if(thisuser.perms.admin || thisuser.admin || oevents[i].user.cid == cid){
				parsePerms(nevent.editors, function(d){
					event.perms.edit = d;
					parsePerms(nevent.viewers, function(f){
						event.perms.view = f;
						everythingElse();
					});
				});

			} else {
				everythingElse();
			}

			function everythingElse(){

				// console.log("nevent: ", nevent);

				var nots = event.notifications.split(",");
				for(var a = 0; a<nots.length; a++){
					nots[a] = nots[a].trim();
					if(nots[a].length < 5){
						nots[a] = null;
					} else {
						var l = nots[a].replace(/[^a-zA-Z]/, ''),
								d = new Date(event.startdate),
								n = nots[a].replace(/[^0-9]/g, '');
						switch(l){
							case 'd':
								d.setDate(d.getDate()-n);
								break;
							case 'm':
								d.setMinutes(d.getMinutes()-n);
								break;
							case 'h':
								d.setHours(d.getHours()-n);
								break;
						}

						// console.log("l and n\n" + l + "  "+ n);

						nots[a] = d;
					}

				}

				nots = nots.filter(function(val){
					return !!val;
				});

				event.notificationDates = nots || [];
				event.user = nevent.user;

				if(thisuser.perms.admin ||
						thisuser.admin ||
						thisuser.perms.editEvents ||
						(!oevents[i] && thisuser.perms.createEvents) ||
						(oevents[i] && (thisuser.can("edit", oevents[i]) ||
						oevents[i].user.cid == cid))){

					var bool = !oevents[i] || !oevents[i].pid || !oevents[i].url;

					oevents[i] = extend(oevents[i] || {}, nevent);

					if(bool){
						//callback(null, oevents, thisuser, "/topics");
						makePost(event, function(url, pid, tid){

							//console.log(url);

							oevents[i].pid = pid;
							oevents[i].url = url;
							oevents[i].tid = tid;
							callback(null, oevents, thisuser, oevents[i]);
						});
					} else {
						//callback(null, oevents, thisuser, "/topics");
						updatePost(nevent, oevents[i].pid, function(){
							callback(null, oevents, thisuser, oevents[i]);
						});
					}

				} else if(oevents[i] && thisuser.can("view", oevents[i])){
					if(nevent.responses[cid] && nevent.responses[cid].value){
						oevents[i].responses[cid].value = nevent.responses[cid].value;
						callback(null, oevents, thisuser, oevents[i]);
					}
				}
			}
		});

	}

	function reduce(cid, oevents, callback){

		var retEvents = [];

		//console.log("in reduce");

		getUser(cid, function(thisuser, err){

			//console.log("thisuser: ", thisuser, "err: ", err);

			if(err){
				return callback(null, null, err);
			}

			if(thisuser.perms.admin ||
					thisuser.admin ||
					thisuser.perms.editEvents ){
				callback(oevents, thisuser);
			} else {
				for(var i=0; i < oevents.length; i++){
					if(thisuser.can("view", oevents[i])){
						retEvents[i] = oevents[i];
						retEvents[i].editable = thisuser.can("edit", oevents[i]) || +retEvents[i].user.cid === +cid;
					}
				}
				callback(retEvents, thisuser);
			}
		});

	}

	function validate(oevent, uid){

		var fieldsToCopy = [
			"startdate",			// parsable by Date
			"enddate",				// ^
			"name",						// clean of all html and styling
			"place",					// parsed by marked
			"description",		// ^
			"allday",					// must be true of false
			"notifications",	// must be a list of number-letter pairs
												// 	separated by commas
												//	where the letters are only d, h, m
			"responses",			// only the one from the current user
			"editors",				// comma-separated list of names, with
												//  prefixes of (-) dashes and (@) at symbols
			"viewers"					// ^
		];

		var tests = {
			name: function(val){
				return [val.length >= 3, sanitize(val), "Name must be three characters or longer."];
			},
			startdate: function(val){
				return [!isNaN((new Date(val)).valueOf()), val, "The start date is in an unrecognizable format."];
			},
			enddate: function(val){
				return [!isNaN((new Date(val)).valueOf()), val, "The end date is in an unrecognizable format."];
			},
			place: function(val){
				event.htmlPlace = marked(val);
				return [true, val, ""];
			},
			notifications: function(val){
				var aval = val.split(",");
				var bool = true;
				for(var i=0; i<aval.length; i++){
					if(!(/(\s?[0-9]+[mhd]\s?)/).test(aval[i])){
						bool = false;
					}
				}
				return [bool || !val, val, "Notifications must be numbers separated by commas and suffixed by 'm,' 'h,' or 'd'"];
			},
			viewers: function(val){
				var aval = val.split(",");
				var bool = true;
				for(var i=0; i<aval.length; i++){
					if(!(/(\s?-?@?\w+\s?)/).test(aval[i])){
						bool = false;
					}
				}
				return [bool || !val, val, "Viewer groups and users must be separated by commas and prefixed by (-) and/or (@) in that order"];
			},
			editors: function(val){
				var aval = val.split(",");
				var bool = true;
				for(var i=0; i<aval.length; i++){
					if(!(/(\s?-?@?\w+\s?)/).test(aval[i])){
						bool = false;
					}
				}
				return [bool || !val, val, "Editor groups and users must be separated by commas and prefixed by (-) and/or (@) in that order"];
			},
			responses: function(val){

				var bool = true;
				for(var x in val){
					if(val.hasOwnProperty(x)){
						if(!(val[x].value === "invited" ||
								val[x].value === "not-attending" ||
								val[x].value === "maybe" ||
								val[x].value === "attending")){
							bool = false;
						}
					}
				}
				return [bool, val, "The value of your response was corrupted. Try again"];
			},
			description: function(val){
				event.html = marked(val);
				return [true, val, ""];
			},
			public: function(val){
				return [true, val, ""];
			},
			allday: function(val){
				return [true, val, ""];
			}
		};

		var passed = true, errors = {}, event = {};

		for(var x in tests){
			if(tests.hasOwnProperty(x)){
				var result = tests[x](oevent[x]);
				if(!result[0]){
					passed = false;
					errors[x] = result[2];
				}
				event[x] = result[1];

			}
		}

		return { passed: passed, event: event, errors: errors };

	}

	function getUser(cid, callback){
		groups.getUserGroups(cid, function(err, userGroups){

			if(err){
				return callback(null, err);
			}

			user.isAdministrator(cid, function(err, bool){

				if(err){
					return callback(null, err);
				}

				getData(function(err, data){
					//var userGroups = [];

					if(err){
						return callback(null, err);
					}

					var admin = false, edit=false, create=false;
					for(var i=0; i<userGroups.length; i++){
						if(data.perms.admin.groups[userGroups[i]] === 1){
							admin = true;
						}
						if(data.perms.editEvents.groups[userGroups[i]] === 1){
							edit = true;
						}
						if(data.perms.createEvents.groups[userGroups[i]] === 1){
							create = true;
						}
					}
					for(i=0; i<userGroups.length; i++){
						if(data.perms.admin.groups[userGroups[i]] === -1){
							admin = false;
						}
						if(data.perms.editEvents.groups[userGroups[i]] === -1){
							edit = false;
						}
						if(data.perms.createEvents.groups[userGroups[i]] === -1){
							create = false;
						}
					}

					var u = {
						perms: {
							admin: (data.perms.admin.users[cid] > -1) && (data.perms.admin.users[cid] === 1 || admin),
							editEvents: data.perms.editEvents.users[cid] > -1 && (data.perms.editEvents.users[cid] === 1 || edit),
							createEvents: data.perms.editEvents.users[cid] > -1 && (data.perms.createEvents.users[cid] === 1 || create)
						},
						can: function(action, event){
							if(!event || !event.perms || !event.perms[action]){
								return false;
							}

							if(action === "view" && event.public){
								return true;
							}

							var yes = false;
							for(i=0; i<userGroups.length; i++){
								if(event.perms[action].groups[userGroups[i]] === 1){
									yes = true;
								} else if(event.perms[action].groups[userGroups[i]] === -1){
									yes = false;
									break;
								}
							}
							return event.perms[action].users[cid] > -1 && (event.perms[action].users[cid] === 1 || yes);
						},
						admin: bool
					};
					//console.log(cid, u);

					callback(u);
				});
			});
		});

	}

	function parsePerms(str, callback){

		// first, split up the string

		str = str.split(",");

		var allowedUsers = [], allowedGroups = [], excludedUsers = [], excludedGroups = [];

		for(var a = 0; a<str.length; a++){
			var b = str[a].trim();
			if(b.indexOf("-") === 0){
				// excluded
				b = b.replace("-", "");
				if(b.indexOf("@") === 0){
					// user
					b = b.replace("@", "");
					if(b){
						excludedUsers.push(b);
					}
				} else {
					// group
					if(b){
						excludedGroups.push(b);
					}
				}
			} else {
				// included
				if(b.indexOf("@") === 0){
					// user
					b = b.replace("@", "");
					if(b){
						allowedUsers.push(b);
					}
				} else {
					// group
					if(b){
						allowedGroups.push(b);
					}
				}
			}
		}

		//console.log(0, allowedUsers, allowedGroups, excludedUsers, excludedGroups);

		async.parallel([
			function(next){
				async.map(allowedUsers, function(allowedUser, nxt){
					user.search(allowedUser, function(err, info){
						//console.log(info);
						nxt(err, +info.users[0].uid);
					});
				}, function(err, result){
					allowedUsers = result;
					next();
				});
			},
			function(next){
				async.map(excludedUsers, function(excludedUser, nxt){
					user.search(excludedUser, function(err, info){
						nxt(err, +info.users[0].uid);
					});
				}, function(err, result){
					excludedUsers = result;
					next();
				});
			},
			function(next){
				async.map(allowedGroups, function(allowedGroup, nxt){
					groups.search(allowedGroup, {}, function(err, info){
						//console.log(0);
						nxt(err, info[0]);
					});
				}, function(err, result){
					allowedGroups = result;
					next();
				});
			},
			function(next){
				async.map(excludedGroups, function(excludedGroup, nxt){
					groups.search(excludedGroup, {}, function(err, info){
						nxt(err, info[0]);
					});
				}, function(err, result){
					excludedGroups = result;
					next();
				});
			}
		], function(){
			var event = {
				users: {},
				groups: {}
			};
			for(var i=0; i<allowedUsers.length; i++){
				event.users[allowedUsers[i]] = 1;
			}
			for(i=0; i<excludedUsers.length; i++){
				event.users[excludedUsers[i]] = -1;
			}
			for(i=0; i<allowedGroups.length; i++){
				event.groups[allowedGroups[i]] = 1;
			}
			for(i=0; i<excludedGroups.length; i++){
				event.groups[excludedGroups[i]] = -1;
			}

			//console.log(1, event);

			callback( event);
		});

	}

	var checkDelay = 60*1000;

	function removeNotification(eventID, notifIndex){
		getData(function(err, data){
			if(err){
				return err;
			}

			//console.log(data.events[eventID].notificationDates[notifIndex]);

			data.events[eventID].sentNotifications = data.events[eventID].sentNotifications || [];

			data.events[eventID].sentNotifications.push(data.events[eventID].notificationDates[notifIndex]);
			setData(data, function(){});
		});
	}

	function checkNotifications(after){

		after = after || function(){};

		getData(function(err, data){
			if(err){
				console.error("data error: "+err);
				setTimeout(checkNotifications, checkDelay);
				return after();
			}
			var today = +(new Date());
			async.map(data.events, function(event, callback){

				if(!event){
					return callback();
				}
				if(event.sentNotifications && event.sentNotifications.length){
					event.notificationDates = event.notificationDates.filter(function(val){
						return event.sentNotifications.indexOf(val) === -1;
					});
				}

				if(!event.notificationDates || !event.notificationDates.length){
					return callback();
				}

				var users = Object.keys(event.perms.view.users).filter(function(value){
					return event.perms.view.users[value] === 1;
				});
				users = users.concat(Object.keys(event.perms.edit.users).filter(function(value){
					return event.perms.edit.users[value] === 1;
				}));

				var removeusers = Object.keys(event.perms.view.users).filter(function(value){
					return event.perms.view.users[value] === -1;
				});
				removeusers = removeusers.concat(Object.keys(event.perms.edit.users).filter(function(value){
					return event.perms.edit.users[value] === -1;
				}));

				var groupusers = [], removegroupusers = [], thegroups = event.perms.view.groups;
				for(var x in event.perms.edit.groups){
					if(event.perms.edit.groups.hasOwnProperty(x)){
						thegroups[x] = event.perms.edit.groups[x];
					}
				}

				async.map(Object.keys(thegroups), function(key, call){
					groups.get(key, {}, function(err, info){
						if(err){
							return call(err);
						}

						if(thegroups[key] === 1){
							groupusers = groupusers.concat(info.members);
						} else if(thegroups[key] === -1){
							removegroupusers = removegroupusers.concat(info.members);
						}

						call();
					});

				}, function(err){
					users = users.concat(groupusers.filter(function(key){
						return removegroupusers.indexOf(key) === -1;
					}));
					users = users.filter(function(key){
						return removeusers.indexOf(key) === -1;
					});
					users.push(event.user.cid);

					async.map(Object.keys(event.notificationDates), function(b, cb){
						console.log("date comparison: ", +new Date(event.notificationDates[b]), today, event.notificationDates[b], new Date());
						if(+new Date(event.notificationDates[b]) <= today){

							notifs.create({
								nid: "calendar:events["+event.id+"].notify["+event.pid+"]",
								pid: event.pid,
								tid: event.tid,
								bodyShort: "Calendar: "+event.name,
								bodyLong: event.html,
								from: event.user.cid
							}, function(err, d){
								if(err || !d){
									console.log("Error while notifying", err);
									return cb(err || "no d");
								}
								notifs.push(d, users, function(err){
									removeNotification(event.id, b);
									cb(err);
								});
							});

						} else {
							cb();
						}

					}, function(err, result){
						if(err){
							console.error("async error 2: "+err);
						}
						callback(err, result);
					});
				});

			}, function(err){
				if(err){
					console.error(err);
				}
				setTimeout(checkNotifications, checkDelay);
				after();
			});
		});
	}

})(module.exports, module);
