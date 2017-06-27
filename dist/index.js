'use strict';

var debug = require('debug')('node-vault');
var tv4 = require('tv4');
var commands = require('./commands.js');
var mustache = require('mustache');
var rp = require('request-promise');
var Promise = require('bluebird');

module.exports = function () {
  var config = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

  // load conditional dependencies
  debug = config.debug || debug;
  tv4 = config.tv4 || tv4;
  commands = config.commands || commands;
  mustache = config.mustache || mustache;
  rp = (config['request-promise'] || rp).defaults({
    json: true,
    resolveWithFullResponse: true,
    simple: false,
    strictSSL: !process.env.VAULT_SKIP_VERIFY
  });
  Promise = config.Promise || Promise;
  var client = {};

  function handleVaultResponse(response) {
    if (!response) return Promise.reject(new Error('No response passed'));
    debug(response.statusCode);
    if (response.statusCode !== 200 && response.statusCode !== 204) {
      // handle health response not as error
      if (response.request.path.match(/sys\/health/) !== null) {
        return Promise.resolve(response.body);
      }
      var message = void 0;
      if (response.body && response.body.errors && response.body.errors.length > 0) {
        message = response.body.errors[0];
      } else {
        message = 'Status ' + response.statusCode;
      }
      var error = new Error(message);
      return Promise.reject(error);
    }
    return Promise.resolve(response.body);
  }

  client.handleVaultResponse = handleVaultResponse;

  // defaults
  client.apiVersion = config.apiVersion || 'v1';
  client.endpoint = config.endpoint || process.env.VAULT_ADDR || 'http://127.0.0.1:8200';
  client.token = config.token || process.env.VAULT_TOKEN;

  var requestSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string'
      },
      method: {
        type: 'string'
      }
    },
    required: ['path', 'method']
  };

  // Handle any HTTP requests
  client.request = function () {
    var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

    var valid = tv4.validate(options, requestSchema);
    if (!valid) return Promise.reject(tv4.error);
    var uri = client.endpoint + '/' + client.apiVersion + options.path;
    // Replace variables in uri.
    uri = mustache.render(uri, options.json);
    // Replace unicode encodings.
    uri = uri.replace(/&#x2F;/g, '/');
    options.headers = options.headers || {};
    if (client.token !== undefined || client.token !== null || client.token !== '') {
      options.headers['X-Vault-Token'] = client.token;
    }
    options.uri = uri;
    debug(options.method, uri);
    // debug(options.json);
    return rp(options).then(handleVaultResponse);
  };

  client.help = function (path, requestOptions) {
    debug('help for ' + path);
    var options = Object.assign({}, config.requestOptions, requestOptions);
    options.path = '/' + path + '?help=1';
    options.method = 'GET';
    return client.request(options);
  };

  client.write = function (path, data, requestOptions) {
    debug('write %o to %s', data, path);
    var options = Object.assign({}, config.requestOptions, requestOptions);
    options.path = '/' + path;
    options.json = data;
    options.method = 'PUT';
    return client.request(options);
  };

  client.read = function (path, requestOptions) {
    debug('read ' + path);
    var options = Object.assign({}, config.requestOptions, requestOptions);
    options.path = '/' + path;
    options.method = 'GET';
    return client.request(options);
  };

  client.list = function (path, requestOptions) {
    debug('list ' + path);
    var options = Object.assign({}, config.requestOptions, requestOptions);
    options.path = '/' + path;
    options.method = 'LIST';
    return client.request(options);
  };

  client.delete = function (path, requestOptions) {
    debug('delete ' + path);
    var options = Object.assign({}, config.requestOptions, requestOptions);
    options.path = '/' + path;
    options.method = 'DELETE';
    return client.request(options);
  };

  function validate(json, schema) {
    // ignore validation if no schema
    if (schema === undefined) return Promise.resolve();
    var valid = tv4.validate(json, schema);
    if (!valid) {
      debug(tv4.error.dataPath);
      debug(tv4.error.message);
      return Promise.reject(tv4.error);
    }
    return Promise.resolve();
  }

  function extendOptions(conf, options) {
    var schema = conf.schema.query;
    // no schema for the query -> no need to extend
    if (!schema) return Promise.resolve(options);
    var params = [];
    var _iteratorNormalCompletion = true;
    var _didIteratorError = false;
    var _iteratorError = undefined;

    try {
      for (var _iterator = Object.keys(schema.properties)[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
        var key = _step.value;

        if (key in options.json) {
          params.push(key + '=' + encodeURIComponent(options.json[key]));
        }
      }
    } catch (err) {
      _didIteratorError = true;
      _iteratorError = err;
    } finally {
      try {
        if (!_iteratorNormalCompletion && _iterator.return) {
          _iterator.return();
        }
      } finally {
        if (_didIteratorError) {
          throw _iteratorError;
        }
      }
    }

    if (params.length > 0) {
      options.path += '?' + params.join('&');
    }
    return Promise.resolve(options);
  }

  function generateFunction(name, conf) {
    client[name] = function () {
      var args = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

      var options = Object.assign({}, config.requestOptions, args.requestOptions);
      options.method = conf.method;
      options.path = conf.path;
      options.json = args;
      // no schema object -> no validation
      if (!conf.schema) return client.request(options);
      // else do validation of request URL and body
      return validate(options.json, conf.schema.req).then(validate(options.json, conf.schema.query)).then(function () {
        return extendOptions(conf, options);
      }).then(function (extendedOptions) {
        return client.request(extendedOptions);
      });
    };
  }

  client.generateFunction = generateFunction;

  // protecting global object properties from being added
  // enforcing the immutable rule: https://github.com/airbnb/javascript#iterators-and-generators
  // going the functional way first defining a wrapper function
  var assignFunctions = function assignFunctions(commandName) {
    return generateFunction(commandName, commands[commandName]);
  };
  Object.keys(commands).forEach(assignFunctions);

  return client;
};