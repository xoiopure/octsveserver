"use strict";

const async = require("async");
const redis = require("redis");
const EventEmitter = require("events");
const log = require("./logger")("redis-messenger");
const redisUtil = require("./redis-util");
const Scripto = require("redis-scripto");
const path = require("path");
const uuid = require("uuid");
const config = require("./config.json");

class RedisMessenger extends EventEmitter {
	constructor() {
		super();
		this._client = redisUtil.createClient();
		this._subscribed = false;
		this._scriptManager = null;

		this._client.on("error", (err) => {
			log.error("REDIS CLIENT", err);
		});
		this._client.on("end", () => {
			log.info("Redis connection ended");
		});
		this._client.on("reconnecting", (info) => {
			log.info("Redis reconnecting:", info);
		});
	}

	// PUBLIC METHODS

	enableScripts() {
		this._scriptManager = new Scripto(this._client);
		this._scriptManager.loadFromFile("get-sesscode", path.join(__dirname, "lua/get-sesscode.lua"));
		return this;
	}

	input(sessCode, name, content) {
		this._ensureNotSubscribed();

		let channel = redisUtil.chan.input(sessCode);
		let messageString = this._serializeMessage(name, content);

		this._client.publish(channel, messageString);
	}

	subscribeToInput() {
		this._psubscribe(redisUtil.chan.input("*"));
		this.on("_message", this._emitMessage.bind(this));
		return this;
	}

	output(sessCode, name, content) {
		this._ensureNotSubscribed();

		let channel = redisUtil.chan.output(sessCode);
		let messageString = this._serializeMessage(name, content);

		this._client.publish(channel, messageString);
	}

	subscribeToOutput() {
		this._psubscribe(redisUtil.chan.output("*"));
		this.on("_message", this._emitMessage.bind(this));
		return this;
	}

	putSessCode(sessCode, user) {
		this._ensureNotSubscribed();

		let time = new Date().valueOf();

		let multi = this._client.multi();
		multi.zadd(redisUtil.chan.needsOctave, time, sessCode);
		multi.hset(redisUtil.chan.session(sessCode), "user", JSON.stringify(user));
		multi.hset(redisUtil.chan.session(sessCode), "live", "false");
		multi.set(redisUtil.chan.input(sessCode), time);
		multi.set(redisUtil.chan.output(sessCode), time);
		multi.exec(this._handleError.bind(this));
	}

	getSessCode(next) {
		this._runScript("get-sesscode", [redisUtil.chan.needsOctave], [config.worker.token], (err, result) => {
			if (err) this._handleError(err);
			if (result === -1) return next(null, null, null);
			try {
				let user = JSON.parse(result[1]);
				this.touchOutput(result[0]);
				next(null, result[0], user);
			} catch (err) {
				next(err, null, null);
			}
		});
	}

	destroyD(sessCode, reason) {
		this._ensureNotSubscribed();

		let channel = redisUtil.chan.destroyD;
		let message = { sessCode, message: reason };

		let multi = this._client.multi();
		multi.del(redisUtil.chan.session(sessCode));
		multi.del(redisUtil.chan.input(sessCode));
		multi.del(redisUtil.chan.output(sessCode));
		multi.zrem(redisUtil.chan.needsOctave, sessCode);
		multi.publish(channel, JSON.stringify(message));
		multi.exec(this._handleError.bind(this));
	}

	subscribeToDestroyD() {
		this._subscribe(redisUtil.chan.destroyD);
		this.on("_message", (message) => {
			this.emit("destroy-d", message.sessCode, message.message);
		});
		return this;
	}

	destroyU(sessCode, reason) {
		this._ensureNotSubscribed();

		let channel = redisUtil.chan.destroyU;
		let message = { sessCode, message: reason };

		let multi = this._client.multi();
		multi.del(redisUtil.chan.session(sessCode));
		multi.del(redisUtil.chan.input(sessCode));
		multi.del(redisUtil.chan.output(sessCode));
		multi.publish(channel, JSON.stringify(message));
		multi.exec(this._handleError.bind(this));
	}

	subscribeToDestroyU() {
		this._subscribe(redisUtil.chan.destroyU);
		this.on("_message", (message) => {
			this.emit("destroy-u", message.sessCode, message.message);
		});
		return this;
	}

	setLive(sessCode) {
		this._ensureNotSubscribed();

		this._client.hset(redisUtil.chan.session(sessCode), "live", "true");
		this.touchOutput(sessCode);
	}

	isValid(sessCode, next) {
		this._ensureNotSubscribed();

		this._client.hget(redisUtil.chan.session(sessCode), "live", next);
	}

	touchInput(sessCode) {
		this._ensureNotSubscribed();

		let multi = this._client.multi();
		multi.expire(redisUtil.chan.session(sessCode), config.redis.expire.timeout/1000);
		multi.expire(redisUtil.chan.input(sessCode), config.redis.expire.timeout/1000);
		multi.exec(this._handleError.bind(this));
	}

	touchOutput(sessCode) {
		this._ensureNotSubscribed();

		let multi = this._client.multi();
		multi.expire(redisUtil.chan.session(sessCode), config.redis.expire.timeout/1000);
		multi.expire(redisUtil.chan.output(sessCode), config.redis.expire.timeout/1000);
		multi.exec(this._handleError.bind(this));
	}

	subscribeToExpired() {
		this._epsubscribe();
		this.on("_message", (sessCode, channel) => {
			this.emit("expired", sessCode, channel);
		});
		return this;
	}

	requestReboot(id, priority) {
		this._ensureNotSubscribed();

		let channel = redisUtil.chan.rebootRequest;
		let message = { id, isRequest: true, token: config.worker.token,  priority };

		this._client.publish(channel, JSON.stringify(message), this._handleError.bind(this));
	}

	replyToRebootRequest(id, response) {
		this._ensureNotSubscribed();

		let channel = redisUtil.chan.rebootRequest;
		let message = { id, isRequest: false, token: config.worker.token, response };

		this._client.publish(channel, JSON.stringify(message), this._handleError.bind(this));
	}

	subscribeToRebootRequests() {
		this._subscribe(redisUtil.chan.rebootRequest);
		this.on("_message", (message) => {
			this.emit("reboot-request", message.id, message.isRequest, message);
		});
		return this;
	}

	close() {
		this._client.end(true);
	}

	// PRIVATE METHODS

	_subscribe(channel) {
		this._ensureNotSubscribed();
		this._subscribed = true;

		this._client.subscribe(channel);
		this._client.on("message", (channel, message) => {
			try {
				let obj = JSON.parse(message);
				this.emit("_message", obj);
			} catch (err) {
				this._handleError(err);
			}
		});
		return this;
	}

	_psubscribe(pattern) {
		this._ensureNotSubscribed();
		this._subscribed = true;

		this._client.psubscribe(pattern);
		this._client.on("pmessage", (pattern, channel, message) => {
			try {
				let sessCode = redisUtil.getSessCodeFromChannel(channel);
				let obj = JSON.parse(message);
				this.emit("_message", sessCode, obj);
			} catch (err) {
				this._handleError(err);
			}
		});
		return this;
	}

	_epsubscribe() {
		this._ensureNotSubscribed();
		this._subscribed = true;

		this._client.subscribe("__keyevent@0__:expired");
		this._client.on("message", (channel, message) => {
			try {
				let sessCode = redisUtil.getSessCodeFromChannel(message);
				this.emit("_message", sessCode, message);
			} catch (err) {
				// Silently ignore this error; there are many examples of keys that expire that don't have sessCodes in the name.
			}
		});
	}

	_runScript(memo, keys, args, next) {
		this._ensureNotSubscribed();
		if (!this._scriptManager) throw new Error("Need to call enableScripts() first");

		this._scriptManager.run(memo, keys, args, next);
	}

	_serializeMessage(name, content) {
		// Protect against name length
		if (name.length > config.redis.maxPayload) {
			log.error(new Error("Name length exceeds max redis payload length!"));
			return null;
		}

		// If data is too long, save it as an "attachment"
		let contentString = JSON.stringify(content);
		if (contentString.length > config.redis.maxPayload) {
			let id = uuid.v4();
			log.trace("Sending content as attachment:", name, id, contentString.length);
			this._uploadAttachment(id, contentString, this._handleError.bind(this));
			return JSON.stringify({ name, attachment: id });
		}

		// The message is short enough to send as one chunk!
		return JSON.stringify({ name, data: content });
	}

	_emitMessage(sessCode, message) {
		let getData = (next) => {
			if (message.data) return process.nextTick(() => {
				next(null, message.data);
			});
			else {
				return this._downloadAttachment(message.attachment, (err, contentString) => {
					log.trace("Received content as attachment:", message.name, message.attachment, contentString.length);
					try {
						next(null, JSON.parse(contentString));
					} catch (err) {
						next(err);
					}
				});
			}
		};

		this.emit("message", sessCode, message.name, getData);
	}

	_uploadAttachment(id, contentString, next) {
		let channel = redisUtil.chan.attachment(id);

		// Create a new client to offload bandwidth from the main artery channel
		let client = redisUtil.createClient();
		client.on("error", this._handleError.bind(this));

		// Upload the attachment along with an expire time
		let multi = client.multi();
		multi.lpush(channel, contentString);
		multi.expire(channel, config.redis.expire.timeout/1000);
		multi.exec((err) => {
			client.quit();
			next(err);
		});
	}

	_downloadAttachment(id, next) {
		let channel = redisUtil.chan.attachment(id);

		// Create a new client to offload bandwidth from the main artery channel
		let client = redisUtil.createClient();
		client.on("error", this._handleError.bind(this));

		// Download the attachment
		client.brpop(channel, 0, (err, response) => {
			client.quit();
			if (err) return next(err);
			else return next(null, response[1]);
		});
	}

	_handleError() {
		if (arguments[0]) log.warn.apply(this, arguments);
	}

	_ensureNotSubscribed() {
		if (this._subscribed) throw new Error("Can't call this method on a client that is subscribed to a channel");
	}
}

module.exports = RedisMessenger
