'use strict';

function _toConsumableArray(arr) {
    if (Array.isArray(arr)) {
        for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
            arr2[i] = arr[i];
        }
        return arr2;
    } else {
        return Array.from(arr);
    }
}

var request = require('request');
var geocoder = require('geocoder');
var events = require('events');
var GoogleOAuth = require('gpsoauthnode');
var fs = require('fs');
var s2 = require('s2geometry-node');

var Logins = require('./logins');
var proto = require('pokemongo-protobuf');

var pokemonlist = JSON.parse(fs.readFileSync(__dirname + '/pokemons.json', 'utf8'));

var EventEmitter = events.EventEmitter;

var api_url = 'https://pgorelease.nianticlabs.com/plfe/rpc';

function GetCoords(self) {
    var _self$playerInfo = self.playerInfo;
    var latitude = _self$playerInfo.latitude;
    var longitude = _self$playerInfo.longitude;

    return [latitude, longitude];
}

function getNeighbors(lat, lng) {
    var origin = new s2.S2CellId(new s2.S2LatLng(lat, lng)).parent(15);
    var walk = [origin.id()];
    // 10 before and 10 after
    var next = origin.next();
    var prev = origin.prev();
    for (var i = 0; i < 10; i++) {
        // in range(10):
        walk.push(prev.id());
        walk.push(next.id());
        next = next.next();
        prev = prev.prev();
    }
    return walk;
}

function Pokeio() {
    var self = this;
    self.events = new EventEmitter();
    self.j = request.jar();
    self.request = request.defaults({jar: self.j});

    self.google = new GoogleOAuth();

    self.pokemonlist = pokemonlist.pokemon;

    self.playerInfo = {
        accessToken: '',
        debug: true,
        latitude: 0,
        longitude: 0,
        altitude: 0,
        locationName: '',
        provider: '',
        apiEndpoint: ''
    };

    self.DebugPrint = function (str) {
        if (self.playerInfo.debug === true) {
            //self.events.emit('debug',str)
            console.log(str);
        }
    };

    function api_req(api_endpoint, access_token, req, callback) {
        // Auth
        var jwtTokenData = {content: access_token, unknown2: 59};

        var authData = {
            provider: self.playerInfo.provider,
            token: proto.serialize(jwtTokenData, 'POGOProtos.Networking.Envelopes.RequestEnvelope.AuthInfo.JWT')
        };

        var envelop = {};
        envelop.status_code = 2;
        envelop.request_id = 1469378659230941192;
        envelop.requests = req;
        envelop.latitude = self.playerInfo.latitude;
        envelop.longitude = self.playerInfo.longitude;
        envelop.altitude = self.playerInfo.altitude;
        envelop.auth_info = {};
        envelop.auth_info.provider = self.playerInfo.provider;
        envelop.auth_info.token = {};
        envelop.auth_info.token.contents = access_token;
        envelop.auth_info.token.unknown2 = 59;
        envelop.unknown12 = 989;

        var protobuf = proto.serialize(envelop, 'POGOProtos.Networking.Envelopes.RequestEnvelope');
        var options = {
            url: api_endpoint,
            body: protobuf,
            encoding: null,
            headers: {
                'User-Agent': 'Niantic App'
            }
        };

        self.request.post(options, function (err, response, body) {
            if (response === undefined || body === undefined) {
                console.error('[!] RPC Server offline');
                return callback(new Error('RPC Server offline'));
            }
            try {
                var f_ret = proto.parse(body, 'POGOProtos.Networking.Envelopes.ResponseEnvelope');
            } catch (e) {
                if (e.decoded) {
                    // Truncated
                    console.warn(e);
                    f_ret = e.decoded; // Decoded message with missing required fields
                }
            }

            if (f_ret) {
                return callback(null, f_ret);
            } else {
                api_req(api_endpoint, access_token, req, callback);
            }
        });
    }

    self.init = function (username, password, location, provider, callback) {
        if (provider !== 'ptc' && provider !== 'google') {
            return callback(new Error('Invalid provider'));
        }
        // set provider
        self.playerInfo.provider = provider;
        // Updating location
        self.SetLocation(location, function (err, loc) {
            if (err) {
                return callback(err);
            }
            // Getting access token
            self.GetAccessToken(username, password, function (err, token) {
                if (err) {
                    return callback(err);
                }
                // Getting api endpoint
                self.GetApiEndpoint(function (err, api_endpoint) {
                    if (err) {
                        return callback(err);
                    }
                    callback(null);
                });
            });
        });
    };

    self.GetAccessToken = function (user, pass, callback) {
        self.DebugPrint('[i] Logging with user: ' + user);
        if (self.playerInfo.provider === 'ptc') {
            Logins.PokemonClub(user, pass, self, function (err, token) {
                if (err) {
                    return callback(err);
                }

                self.playerInfo.accessToken = token;
                self.DebugPrint('[i] Received PTC access token!');
                callback(null, token);
            });
        } else {
            Logins.GoogleAccount(user, pass, self, function (err, token) {
                if (err) {
                    return callback(err);
                }

                self.playerInfo.accessToken = token;
                self.DebugPrint('[i] Received Google access token!');
                callback(null, token);
            });
        }
    };

    self.GetApiEndpoint = function (callback) {
        var req = [
            {
                request_type: 'GET_PLAYER'
            },
            {
                request_type: 'GET_HATCHED_EGGS'
            },
            {
                request_type: 'GET_INVENTORY'
            },
            {
                request_type: 'CHECK_AWARDED_BADGES'
            },
            {
                request_type: 'DOWNLOAD_SETTINGS'
            }
        ];
        api_req(api_url, self.playerInfo.accessToken, req, function (err, f_ret) {
            if (err) {
                return callback(err);
            }
            var api_endpoint = 'https://' + f_ret.api_url + '/rpc';
            self.playerInfo.apiEndpoint = api_endpoint;
            self.DebugPrint('[i] Received API Endpoint: ' + api_endpoint);
            return callback(null, api_endpoint);
        });
    };

    self.GetInventory = function (callback) {
        var req = [{request_type: 'GET_INVENTORY'}];

        api_req(self.playerInfo.apiEndpoint, self.playerInfo.accessToken, req, function (err, f_ret) {
            if (err) {
                return callback(err);
            } else if (!f_ret || !f_ret.returns || !f_ret.returns[0]) {
                return callback('No result');
            }

            var inventory = proto.parse(f_ret.returns[0], 'POGOProtos.Networking.Responses.GetInventoryResponse');
            return callback(null, inventory);
        });
    };

    self.GetProfile = function (callback) {
        var req = [
            {
                request_type: 'GET_PLAYER'
            }
        ];
        api_req(self.playerInfo.apiEndpoint, self.playerInfo.accessToken, req, function (err, f_ret) {
            if (err) {
                return callback(err);
            } else if (!f_ret || !f_ret.returns || !f_ret.returns[0]) {
                return callback('No result');
            }

            var profile = proto.parse(f_ret.returns[0], 'POGOProtos.Networking.Responses.GetPlayerResponse').player_data;
            if (profile.username) {
                self.DebugPrint('[i] Logged in!');
            }
            callback(null, profile);
        });
    };

    // IN DEVELPOMENT, YES WE KNOW IS NOT WORKING ATM
    self.Heartbeat = function (callback) {
        var _self$playerInfo2 = self.playerInfo;
        var apiEndpoint = _self$playerInfo2.apiEndpoint;
        var accessToken = _self$playerInfo2.accessToken;


        var nullbytes = new Array(21);
        nullbytes.fill(0);

        // Generating walk data using s2 geometry
        var walk = getNeighbors(self.playerInfo.latitude, self.playerInfo.longitude).sort(function (a, b) {
            return a > b;
        });

        var req = [
            {
                request_type: 'GET_MAP_OBJECTS',
                request_message: proto.serialize({
                    cell_id: walk,
                    since_timestamp_ms: nullbytes,
                    latitude: self.playerInfo.latitude,
                    longitude: self.playerInfo.longitude
                }, 'POGOProtos.Networking.Requests.Messages.GetMapObjectsMessage')
            },
            {
                request_type: 'GET_HATCHED_EGGS'
            },
            {
                request_type: 'GET_INVENTORY',
                request_message: proto.serialize({
                    last_timestamp_ms: Date.now().toString()
                }, 'POGOProtos.Networking.Requests.Messages.GetInventoryMessage')
            },
            {
                request_type: 'CHECK_AWARDED_BADGES'
            },
            {
                request_type: 'DOWNLOAD_SETTINGS'
            }
        ];
        api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
            if (err) {
                return callback(err);
            } else if (!f_ret || !f_ret.returns || !f_ret.returns[0]) {
                return callback('No result');
            }

            var heartbeat = proto.parse(f_ret.returns[0], 'POGOProtos.Networking.Responses.GetMapObjectsResponse');
            callback(null, heartbeat);
        });
    };

    self.GetLocation = function (callback) {
        geocoder.reverseGeocode.apply(geocoder, _toConsumableArray(GetCoords(self)).concat([function (err, data) {
            if (data.status === 'ZERO_RESULTS') {
                return callback(new Error('location not found'));
            }

            callback(null, data.results[0].formatted_address);
        }]));
    };

    // Still WIP
    self.GetFort = function (fortid, fortlat, fortlong, callback) {
        var req = [
            {
                request_type: 'FORT_SEARCH',
                request_message: proto.serialize({
                    fort_id: fortid,
                    player_latitude: self.playerInfo.latitude,
                    player_longitude: self.playerInfo.longitude,
                    fort_latitude: fortlat,
                    fort_longitude: fortlong
                }, 'POGOProtos.Networking.Requests.Messages.FortSearchMessage')
            },
            {
                request_type: 'GET_PLAYER'
            }
        ];

        api_req(self.playerInfo.apiEndpoint, self.playerInfo.accessToken, req, function (err, f_ret) {
            if (err) {
                return callback(err);
            } else if (!f_ret || !f_ret.returns || !f_ret.returns[0]) {
                return callback('No result');
            }

            try {
                var FortSearchResponse = proto.parse(f_ret.returns[0], 'POGOProtos.Networking.Responses.FortSearchResponse');
                callback(null, FortSearchResponse);
            } catch (err) {
                callback(err, null);
            }
        });
    };

    //still WIP
    self.CatchPokemon = function (pokemon, normalizedHitPosition, normalizedReticleSize, spinModifier, pokeball, callback) {
        var _self$playerInfo3 = self.playerInfo;
        var apiEndpoint = _self$playerInfo3.apiEndpoint;
        var accessToken = _self$playerInfo3.accessToken;

        var req = [
            {
                request_type: 'CATCH_POKEMON',
                request_message: proto.serialize({
                    encounter_id: pokemon.encounter_id,
                    pokeball: pokeball,
                    normalized_reticle_size: normalizedReticleSize,
                    spawn_point_id: pokemon.spawn_point_id,
                    hit_pokemon: true,
                    spin_modifier: spinModifier,
                    normalized_hit_position: normalizedHitPosition,
                }, 'POGOProtos.Networking.Requests.Messages.CatchPokemonMessage')
            }
        ];

        api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
            if (err) {
                return callback(err);
            } else if (!f_ret || !f_ret.returns || !f_ret.returns[0]) {
                return callback('No result');
            }
            try {
                var catchPokemonResponse = proto.parse(f_ret.returns[0], 'POGOProtos.Networking.Responses.CatchPokemonResponse');
                callback(null, catchPokemonResponse);
            } catch (err) {
                callback(err, null);
            }
        });
    };

    self.EncounterPokemon = function (pokemon, callback) {
        var apiEndpoint = self.playerInfo.apiEndpoint;
        var accessToken = self.playerInfo.accessToken;
        var latitude = self.playerInfo.latitude;
        var longitude = self.playerInfo.longitude;
        var req =
            [{
                request_type: 'ENCOUNTER',
                request_message: proto.serialize({
                    encounter_id: pokemon.encounter_id,
                    spawn_point_id: pokemon.spawn_point_id,
                    player_latitude: latitude,
                    player_longitude: longitude
                }, 'POGOProtos.Networking.Requests.Messages.EncounterMessage')
            }];

        api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
            if (err) {
                return callback(err);
            } else if (!f_ret || !f_ret.returns || !f_ret.returns[0]) {
                return callback('No result');
            }

            try {
                var catchPokemonResponse = proto.parse(f_ret.returns[0], 'POGOProtos.Networking.Responses.EncounterResponse');
                callback(null, catchPokemonResponse);
            } catch (err) {
                callback(err, null);
            }
        });
    };

    self.DropItem = function (itemId, count, callback) {
        var _self$playerInfo4 = self.playerInfo;
        var apiEndpoint = _self$playerInfo4.apiEndpoint;
        var accessToken = _self$playerInfo4.accessToken;
        var latitude = _self$playerInfo4.latitude;
        var longitude = _self$playerInfo4.longitude;

        var req = [
            {
                request_type: 'RECYCLE_INVENTORY_ITEM',
                request_message: proto.serialize({
                    item_id: itemId,
                    count: count
                }, 'POGOProtos.Networking.Requests.Messages.RecycleInventoryItemMessage')
            }
        ];

        api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
            if (err) {
                return callback(err);
            } else if (!f_ret || !f_ret.returns || !f_ret.returns[0]) {
                return callback('No result');
            }

            try {
                var catchPokemonResponse = proto.parse(f_ret.returns[0], 'POGOProtos.Networking.Responses.RecycleInventoryItemResponse');
                callback(null, catchPokemonResponse);
            } catch (err) {
                callback(err, null);
            }
        });
    };

    self.TransferPokemon = function (pokemonId, callback) {
        var _self$playerInfo3 = self.playerInfo;
        var apiEndpoint = _self$playerInfo3.apiEndpoint;
        var accessToken = _self$playerInfo3.accessToken;

        var transferPokemon = {
            'pokemon_id' : pokemonId
        };

        var req = [{request_type: 112, request_message: proto.serialize(transferPokemon,'POGOProtos.Networking.Requests.Messages.ReleasePokemonMessage')}];

        api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
            if (err) {
                return callback(err);
            } else if (!f_ret || !f_ret.returns || !f_ret.returns[0]) {
                return callback('No result');
            }
            try {
                var catchPokemonResponse = proto.parse(f_ret.returns[0],'POGOProtos.Networking.Requests.Responses.ReleasePokemonResponse');
                callback(null, catchPokemonResponse);
            } catch (err) {
                callback(err, null);
            }
        });
    };

    self.GetLocationCoords = function () {
        var _self$playerInfo5 = self.playerInfo;
        var latitude = _self$playerInfo5.latitude;
        var longitude = _self$playerInfo5.longitude;
        var altitude = _self$playerInfo5.altitude;

        return {latitude: latitude, longitude: longitude, altitude: altitude};
    };

    self.SetLocation = function (location, callback) {
        if (location.type !== 'name' && location.type !== 'coords') {
            return callback(new Error('Invalid location type'));
        }

        if (location.type === 'name') {
            if (!location.name) {
                return callback(new Error('You should add a location name'));
            }
            var locationName = location.name;
            geocoder.geocode(locationName, function (err, data) {
                if (err || data.status === 'ZERO_RESULTS') {
                    return callback(new Error('location not found'));
                }

                var _data$results$0$geome = data.results[0].geometry.location;
                var lat = _data$results$0$geome.lat;
                var lng = _data$results$0$geome.lng;


                self.playerInfo.latitude = lat;
                self.playerInfo.longitude = lng;
                self.playerInfo.locationName = locationName;

                callback(null, self.GetLocationCoords());
            });
        } else if (location.type === 'coords') {
            if (!location.coords) {
                return callback(new Error('Coords object missing'));
            }

            self.playerInfo.latitude = location.coords.latitude || self.playerInfo.latitude;
            self.playerInfo.longitude = location.coords.longitude || self.playerInfo.longitude;
            self.playerInfo.altitude = location.coords.altitude || self.playerInfo.altitude;

            geocoder.reverseGeocode.apply(geocoder, _toConsumableArray(GetCoords(self)).concat([function (err, data) {
                if (data && data.status !== 'ZERO_RESULTS' && data.results && data.results[0]) {
                    self.playerInfo.locationName = data.results[0].formatted_address;
                }

                callback(null, self.GetLocationCoords());
            }]));
        }
    };
}

module.exports = new Pokeio();
module.exports.Pokeio = Pokeio;
