/*
 * This file is part of the Companion project
 * Copyright (c) 2018 Bitfocus AS
 * Authors: William Viker <william@bitfocus.io>, Håkon Nessjøen <haakon@bitfocus.io>
 *
 * This program is free software.
 * You should have received a copy of the MIT licence as well as the Bitfocus
 * Individual Contributor License Agreement for companion along with
 * this program.
 *
 * You can be released from the requirements of the license by purchasing
 * a commercial license. Buying such a license is mandatory as soon as you
 * develop commercial activities involving the Companion software without
 * disclosing the source code of your own applications.
 *
 */

var debug = require('debug')('lib/action')
var shortid = require('shortid')
var jsonPatch = require('fast-json-patch')
var _ = require('lodash')
var pTimeout = require('p-timeout')

function action(system) {
	var self = this

	self.system = system
	self.action_definitions = {}
	self.bank_actions = {}
	self.bank_release_actions = {}
	self.bank_status = {}
	self.instance = {}
	self.actions_running = new Set()
	self.timers_running = new Map()

	self.system.emit('db_get', 'bank_actions', function (res) {
		if (res !== undefined) {
			self.bank_actions = res
		}
	})

	self.system.emit('db_get', 'bank_release_actions', function (res) {
		if (res !== undefined) {
			self.bank_release_actions = res
		}
	})

	self.system.on('15to32', function () {
		// Convert config from 15 to 32 keys format
		for (var page in self.config) {
			for (var bank = 1; bank <= global.MAX_BUTTONS; ++bank) {
				if (self.bank_actions[page][bank] === undefined) {
					self.bank_actions[page][bank] = []
				}
				if (self.bank_release_actions[page][bank] === undefined) {
					self.bank_release_actions[page][bank] = []
				}
			}
		}
	})

	function cleanup_actions_list(actions) {
		const res = {}

		for (var page in actions) {
			res[page] = {}
			for (var bank in actions[page]) {
				res[page][bank] = []

				if (actions[page][bank] !== undefined) {
					for (var i = 0; i < actions[page][bank].length; ++i) {
						const action = actions[page][bank][i]
						if (action && self.instance.store.db[action.instance]) {
							res[page][bank].push(action)
						}
					}
				}
			}
		}

		return res
	}

	self.system.on('instance', function (obj) {
		debug('got instance')
		self.instance = obj

		// ensure all actions are valid
		self.bank_actions = cleanup_actions_list(self.bank_actions)
		self.bank_release_actions = cleanup_actions_list(self.bank_release_actions)

		self.system.emit('db_set', 'bank_actions', self.bank_actions)
		self.system.emit('db_set', 'bank_release_actions', self.bank_release_actions)
		self.system.emit('db_save')
	})

	self.system.on('action_save', function () {
		self.system.emit('db_set', 'bank_actions', self.bank_actions)
		self.system.emit('db_set', 'bank_release_actions', self.bank_release_actions)
		self.system.emit('db_save')
		debug('saving')
	})

	self.system.on('instance_delete', function (id) {
		for (var page in self.bank_actions) {
			for (var bank in self.bank_actions[page]) {
				if (self.bank_actions[page][bank] !== undefined) {
					for (var i = 0; i < self.bank_actions[page][bank].length; ++i) {
						var action = self.bank_actions[page][bank][i]

						if (action.instance == id) {
							debug('Deleting action ' + i + ' from button ' + page + '.' + bank)
							self.unsubscribeAction(self.bank_actions[page][bank][i])
							self.bank_actions[page][bank].splice(i, 1)
							self.system.emit('instance_status_check_bank', page, bank)
							i--
						}
					}
				}
			}
		}

		for (var page in self.bank_release_actions) {
			for (var bank in self.bank_release_actions[page]) {
				if (self.bank_release_actions[page][bank] !== undefined) {
					for (var i = 0; i < self.bank_release_actions[page][bank].length; ++i) {
						var action = self.bank_release_actions[page][bank][i]
						if (action.instance == id) {
							debug('Deleting release action ' + i + ' from button ' + page + '.' + bank)
							self.unsubscribeAction(self.bank_release_actions[page][bank][i])
							self.bank_release_actions[page][bank].splice(i, 1)
							self.system.emit('instance_status_check_bank', page, bank)
							i--
						}
					}
				}
			}
		}

		// Remove the definitions
		delete self.action_definitions[id]
		self.io.emit('action_instance_definitions_patch', id, null)
	})

	self.system.on('action_get_banks', function (cb) {
		cb(self.bank_actions)
	})

	self.system.on('release_action_get_banks', function (cb) {
		cb(self.bank_release_actions)
	})

	self.system.on('actions_for_instance', function (instance_id, cb) {
		var actions = []
		for (var page in self.bank_actions) {
			for (var bank in self.bank_actions[page]) {
				for (var i in self.bank_actions[page][bank]) {
					var action = self.bank_actions[page][bank][i]
					if (action.instance == instance_id) {
						actions.push(action)
					}
				}
			}
		}

		self.system.emit('schedule_get_all_actions', function (_actions) {
			for (const action of _actions) {
				if (action.instance == instance_id) {
					actions.push(action)
				}
			}
		})

		cb(actions)
	})

	self.system.on('release_actions_for_instance', function (instance_id, cb) {
		var actions = []
		for (var page in self.bank_release_actions) {
			for (var bank in self.bank_release_actions[page]) {
				for (var i in self.bank_release_actions[page][bank]) {
					var action = self.bank_release_actions[page][bank][i]
					if (action.instance == instance_id) {
						actions.push(action)
					}
				}
			}
		}
		cb(actions)
	})

	function checkBank(page, bank) {
		var status = 0

		if (self.bank_actions[page] === undefined || self.bank_actions[page][bank] === undefined) {
			return
		}
		for (var i = 0; i < self.bank_actions[page][bank].length; ++i) {
			var action = self.bank_actions[page][bank][i]
			system.emit('instance_status_get', action.instance, function (instance_status) {
				if (instance_status !== undefined && status < instance_status[0]) {
					status = instance_status[0]
				}
			})
		}

		if (status != self.bank_status[page + '_' + bank]) {
			self.bank_status[page + '_' + bank] = status
			self.system.emit('action_bank_status_set', page, bank, status)
		}
	}

	self.system.on('action_bank_status_get', function (page, bank, cb) {
		cb(self.bank_status[page + '_' + bank])
	})

	self.system.on('instance_status_check_bank', function (page, bank) {
		checkBank(page, bank)
	})

	self.system.on('instance_status_set', function (instance, level, msg) {
		for (var page in self.bank_actions) {
			if (self.bank_actions[page] !== undefined) {
				for (var bank in self.bank_actions[page]) {
					if (self.bank_actions[page][bank] !== undefined) {
						for (var i = 0; i < self.bank_actions[page][bank].length; ++i) {
							var action = self.bank_actions[page][bank][i]
							if (action.instance == instance) {
								checkBank(page, bank)
							}
						}
					}
				}
			}
		}

		for (var page in self.bank_release_actions) {
			for (var bank in self.bank_release_actions[page]) {
				if (self.bank_release_actions[page] !== undefined && self.bank_release_actions[page][bank] !== undefined) {
					for (var i = 0; i < self.bank_release_actions[page][bank].length; ++i) {
						var action = self.bank_release_actions[page][bank][i]
						if (action.instance == instance) {
							checkBank(page, bank)
						}
					}
				}
			}
		}
	})

	self.system.on('action_running_get', function (page, bank, cb) {
		cb(self.actions_running.has(`${page}_${bank}`))
	})

	// If a user wants to panic-abort all timers running
	self.system.on('action_delayed_abort', function () {
		debug('Aborting delayed actions')

		for (let timer of self.timers_running.keys()) {
			debug('clearing timer')
			clearTimeout(timer)
		}
		self.timers_running.clear()

		var actions_running = self.actions_running //clone hack
		self.actions_running = new Set() // clear the array

		for (let bid of actions_running.keys()) {
			const a = bid.split('_')
			self.system.emit('graphics_bank_invalidate', a[0], a[1])
		}
	})

	// skipUp needed to abort 'up' actions on non-latch buttons
	var skipUp = {}

	// If a user wants to abort a single button actions
	self.system.on('action_abort_bank', function (page, bank, unlatch) {
		var bid = page + '_' + bank
		var cleared = 0

		self.actions_running.delete(bid)

		self.timers_running.forEach((timerId, timer) => {
			if (timerId === bid) {
				if (cleared == 0) {
					debug('Aborting button ', page, ',', bank)
				}
				clearTimeout(timer)
				self.timers_running.delete(timer)
				cleared += 1
			}
		})

		// if requested, reset and skip up-actions
		if (unlatch) {
			self.system.emit('graphics_indicate_push', page, bank, false)
			skipUp[page + '_' + bank] = true
		}

		if (cleared > 0) {
			self.system.emit('graphics_bank_invalidate', page, bank)
		}
	})

	// skipNext needed for 'bank_pressed' callback
	var skipNext = {}
	var pageStyles = ['pageup', 'pagenum', 'pagedown']

	self.system.on('bank_pressed', function (page, bank, direction, deviceid) {
		var bank_config
		var pb = page + '_' + bank

		system.emit('get_bank', page, bank, function (config) {
			bank_config = config
		})

		if (bank_config.latch) {
			if (deviceid == undefined) {
				// web buttons and osc don't set deviceid
				deviceid = 'osc-web'
			}

			if (skipNext[pb] != undefined) {
				// ignore release after latching press
				// from this device
				if (skipNext[pb] == deviceid) {
					delete skipNext[pb] // reduce memory creep
					return
				}
			}

			let reject = false
			system.emit('graphics_is_pushed', page, bank, function (isPushed) {
				// button is being pressed but not yet latched
				// the next button-release from this device needs to be skipped
				// because the 'release' would immediately un-latch the button
				if (direction && !isPushed) {
					skipNext[pb] = deviceid
				} else if (direction && isPushed) {
					// button is latched, prevent duplicate down actions
					// the following 'release' will run the up actions
					reject = true
				} else if (!(direction || isPushed)) {
					// button is up, prevent duplicate up actions
					reject = true
				}
			})

			if (reject) {
				//debug("Latch button duplicate " + (direction? "down":"up") )
				return
			}
		}

		if (skipUp[pb]) {
			delete skipUp[pb]
			if (!bank_config.latch) {
				return
			}
		}

		// magic page keys only respond to push so ignore the release
		// they also don't have a 'pushed' graphics indication
		// so process the action and return before trying to
		// indicate 'pushed'. Otherwise when the 'unpush' graphics
		// occurs, it will re-draw the old button on the new (wrong) page
		if (pageStyles.includes(bank_config.style)) {
			if (direction === true) {
				if (bank_config.style == 'pageup') {
					self.system.emit('device_page_up', deviceid)
				} else if (bank_config.style == 'pagenum') {
					self.system.emit('device_page_set', deviceid, 1)
				} else if (bank_config.style == 'pagedown') {
					self.system.emit('device_page_down', deviceid)
				}
			}
			// no actions allowed on page buttons so we're done
			return
		}

		system.emit('graphics_indicate_push', page, bank, direction, deviceid)

		var obj = self.bank_actions

		// find release actions if the direction is up
		if (direction === false) {
			obj = self.bank_release_actions
		}

		if (obj[page] === undefined || obj[page][bank] === undefined || obj[page][bank].length === 0) {
			return
		}

		debug('found actions')

		const bankId = `${page}_${bank}`
		system.emit('action_run_multiple', obj[page][bank], bankId, bank_config.relative_delay, {
			deviceid: deviceid,
			page: page,
			bank: bank,
		})
	})

	self.system.on('action_run_multiple', function (actions, groupId, relative_delay, run_source) {
		// Handle whether the delays are absolute or relative.
		var action_delay = 0
		for (var n in actions) {
			var a = actions[n]
			var this_delay = parseInt(a.delay === undefined || a.delay === '' ? 0 : a.delay)

			if (relative_delay) {
				// Relative delay: each action's delay adds to the next.
				action_delay += this_delay
			} else {
				// Absolute delay: each delay is its own.
				action_delay = this_delay
			}

			// Create the property .effective_delay. Don't change the user's .delay property.
			a.effective_delay = action_delay
		}

		let has_delayed = false
		for (var n in actions) {
			var a = actions[n]
			var delay = a.effective_delay === undefined ? 0 : parseInt(a.effective_delay)
			delete a.effective_delay

			debug('Running action', a)

			if (self.instance !== undefined && self.instance.store !== undefined && self.instance.store.db !== undefined) {
				if (self.instance.store.db[a.instance] !== undefined && self.instance.store.db[a.instance].enabled !== false) {
					// is this a timedelayed action?
					if (delay > 0) {
						has_delayed = true
						;(function (action, delay_time) {
							var timer = setTimeout(function () {
								self.system.emit('action_run', action, run_source)

								self.timers_running.delete(timer)

								// Stop timer-indication
								const hasAnotherTimer = Array.from(self.timers_running.values()).find((v) => v === groupId)
								if (hasAnotherTimer === undefined) {
									self.actions_running.delete(groupId)
									if (run_source) {
										self.system.emit('graphics_bank_invalidate', run_source.page, run_source.bank)
									}
								}
							}, delay_time)

							self.timers_running.set(timer, groupId)
						})(a, delay)
					}

					// or is it immediate
					else {
						self.system.emit('action_run', a, run_source)
					}
				} else {
					debug('not running action for disabled instance')
				}
			} else {
				debug("wow, instance store didn't exist")
			}
		}

		if (has_delayed) {
			// Start timer-indication
			self.actions_running.add(groupId)

			if (run_source) {
				self.system.emit('graphics_bank_invalidate', run_source.page, run_source.bank)
			}
		}
	})

	self.system.on('action_run', function (action, extras) {
		if (self.instance !== undefined && self.instance.store !== undefined && self.instance.store.db !== undefined) {
			self.system.emit('instance_get', action.instance, function (instance) {
				if (
					instance !== undefined &&
					self.instance.store.db[action.instance] !== undefined &&
					self.instance.store.db[action.instance].enabled !== false
				) {
					const definition = self.getActionDefinition(action.instance, action.action)

					try {
						let result = null

						// Ask instance to execute action
						if (
							definition !== undefined &&
							definition.callback !== undefined &&
							typeof definition.callback == 'function'
						) {
							result = definition.callback(action, extras)
						} else if (typeof instance.action == 'function') {
							result = instance.action(action, extras)
						} else {
							debug(`ERROR: instance "${instance.label}" does not have a handler for the "${action.action}" action`)
						}

						if (result) {
							// Make sure that we don't leave a unhandled promise
							Promise.resolve(result).catch((e) => {
								self.system.emit(
									'log',
									'instance(' + instance.label + ')',
									'warn',
									'Error executing action: ' + e.message
								)
							})
						}
					} catch (e) {
						self.system.emit('log', 'instance(' + instance.label + ')', 'warn', 'Error executing action: ' + e.message)
					}
				} else {
					debug('trying to run action on a missing instance.', action)
				}
			})
		}
	})

	self.system.emit('io_get', function (io) {
		self.io = io
		self.system.on('io_connect', function (client) {
			function sendResult(answer, name, ...args) {
				if (typeof answer === 'function') {
					answer(...args)
				} else {
					client.emit(name, ...args)
				}
			}

			client.on('action_instance_definitions_get', function (answer) {
				answer(self.action_definitions)
			})

			client.on('bank_update_action_delay', function (page, bank, action, value) {
				var bp = self.bank_actions[page][bank]
				if (bp !== undefined) {
					for (var n in bp) {
						var obj = bp[n]
						if (obj !== undefined && obj.id === action) {
							self.bank_actions[page][bank][n].delay = value
							self.system.emit('action_save')
						}
					}
				}
			})

			client.on('bank_update_release_action_delay', function (page, bank, action, value) {
				var bp = self.bank_release_actions[page][bank]
				if (bp !== undefined) {
					for (var n in bp) {
						var obj = bp[n]
						if (obj !== undefined && obj.id === action) {
							self.bank_release_actions[page][bank][n].delay = value
							self.system.emit('action_save')
						}
					}
				}
			})

			client.on('bank_update_action_option', function (page, bank, action, option, value) {
				debug('bank_update_action_option', page, bank, action, option, value)
				var bp = self.bank_actions[page][bank]
				if (bp !== undefined) {
					for (var n in bp) {
						var obj = bp[n]
						if (obj !== undefined && obj.id === action) {
							self.unsubscribeAction(obj)
							if (obj.options === undefined) {
								obj.options = {}
							}
							obj.options[option] = value
							self.subscribeAction(obj)
							self.system.emit('action_save')
						}
					}
				}
			})

			client.on('bank_release_action_update_option', function (page, bank, action, option, value) {
				debug('bank_release_action_update_option', page, bank, action, option, value)
				var bp = self.bank_release_actions[page][bank]
				if (bp !== undefined) {
					for (var n in bp) {
						var obj = bp[n]
						if (obj !== undefined && obj.id === action) {
							self.unsubscribeAction(obj)
							if (obj.options === undefined) {
								obj.options = {}
							}
							obj.options[option] = value
							self.subscribeAction(obj)
							self.system.emit('action_save')
						}
					}
				}
			})

			client.on('action_get_defaults', function (action, answer) {
				var s = action.split(/:/)
				var act = {
					id: shortid.generate(),
					label: action,
					instance: s[0],
					action: s[1],
					options: {},
				}

				if (!self.instance.store.db[act.instance]) {
					// Action is not valid
					return
				}

				const definition = self.getActionDefinition(act.instance, act.action)
				if (definition) {
					if (definition.options !== undefined && definition.options.length > 0) {
						for (var j in definition.options) {
							var opt = definition.options[j]
							act.options[opt.id] = opt.default
						}
					}
				}

				answer(act)
			})

			client.on('bank_action_add', function (page, bank, action, answer) {
				if (self.bank_actions[page] === undefined) self.bank_actions[page] = {}
				if (self.bank_actions[page][bank] === undefined) self.bank_actions[page][bank] = []
				var s = action.split(/:/)

				var act = {
					id: shortid.generate(),
					label: action,
					instance: s[0],
					action: s[1],
					options: {},
				}

				if (!self.instance.store.db[act.instance]) {
					// Action is not valid
					return
				}

				const definition = self.getActionDefinition(act.instance, act.action)
				if (definition) {
					if (definition.options !== undefined && definition.options.length > 0) {
						for (var j in definition.options) {
							var opt = definition.options[j]
							act.options[opt.id] = opt.default
						}
					}
				}

				self.bank_actions[page][bank].push(act)
				self.subscribeAction(act)

				system.emit('action_save')
				sendResult(answer, 'bank_actions_get:result', page, bank, self.bank_actions[page][bank])
				system.emit('instance_status_check_bank', page, bank)
			})

			client.on('bank_addReleaseAction', function (page, bank, action, answer) {
				if (self.bank_release_actions[page] === undefined) self.bank_release_actions[page] = {}
				if (self.bank_release_actions[page][bank] === undefined) self.bank_release_actions[page][bank] = []
				var s = action.split(/:/)

				var act = {
					id: shortid.generate(),
					label: action,
					instance: s[0],
					action: s[1],
					options: {},
				}

				if (!self.instance.store.db[act.instance]) {
					// Action is not valid
					return
				}

				const definition = self.getActionDefinition(act.instance, act.action)
				if (definition) {
					if (definition.options !== undefined && definition.options.length > 0) {
						for (var j in definition.options) {
							var opt = definition.options[j]
							act.options[opt.id] = opt.default
						}
					}
				}

				self.bank_release_actions[page][bank].push(act)
				self.subscribeAction(act)

				system.emit('action_save')
				sendResult(answer, 'bank_release_actions_get:result', page, bank, self.bank_release_actions[page][bank])
				system.emit('instance_status_check_bank', page, bank)
			})

			client.on('bank_action_delete', function (page, bank, id, answer) {
				var ba = self.bank_actions[page][bank]

				for (var n in ba) {
					if (ba[n].id == id) {
						self.unsubscribeAction(self.bank_actions[page][bank][n])
						delete self.bank_actions[page][bank][n]
						break
					}
				}

				var cleanup = []

				for (var n in ba) {
					if (ba[n] !== null) {
						cleanup.push(ba[n])
					}
				}

				self.bank_actions[page][bank] = cleanup

				system.emit('action_save')
				sendResult(answer, 'bank_actions_get:result', page, bank, self.bank_actions[page][bank])
				system.emit('instance_status_check_bank', page, bank)
			})

			client.on('bank_release_action_delete', function (page, bank, id, answer) {
				var ba = self.bank_release_actions[page][bank]

				for (var n in ba) {
					if (ba[n].id == id) {
						self.unsubscribeAction(self.bank_release_actions[page][bank][n])
						delete self.bank_release_actions[page][bank][n]
						break
					}
				}

				var cleanup = []

				for (var n in ba) {
					if (ba[n] !== null) {
						cleanup.push(ba[n])
					}
				}

				self.bank_release_actions[page][bank] = cleanup

				system.emit('action_save')
				sendResult(answer, 'bank_release_actions_get:result', page, bank, self.bank_release_actions[page][bank])
				system.emit('instance_status_check_bank', page, bank)
			})

			client.on('bank_actions_get', function (page, bank, answer) {
				if (self.bank_actions[page] === undefined) self.bank_actions[page] = {}
				if (self.bank_actions[page][bank] === undefined) self.bank_actions[page][bank] = []
				sendResult(answer, 'bank_actions_get:result', page, bank, self.bank_actions[page][bank])
			})

			client.on('bank_release_actions_get', function (page, bank, answer) {
				if (self.bank_release_actions[page] === undefined) self.bank_release_actions[page] = {}
				if (self.bank_release_actions[page][bank] === undefined) self.bank_release_actions[page][bank] = []
				sendResult(answer, 'bank_release_actions_get:result', page, bank, self.bank_release_actions[page][bank])
			})

			client.on('bank_update_action_option_order', function (page, bank, old_index, new_index) {
				var bp = self.bank_actions[page][bank]
				if (bp !== undefined) {
					bp.splice(new_index, 0, bp.splice(old_index, 1)[0])
					self.system.emit('action_save')
				}
			})

			client.on('bank_release_action_update_option_order', function (page, bank, old_index, new_index) {
				var bp = self.bank_release_actions[page][bank]
				if (bp !== undefined) {
					bp.splice(new_index, 0, bp.splice(old_index, 1)[0])
					self.system.emit('action_save')
				}
			})

			client.on('bank_action_learn', function (page, bank, action) {
				var bp = self.bank_actions[page][bank]
				if (bp !== undefined) {
					for (var n in bp) {
						var actionObj = bp[n]
						if (actionObj !== undefined && actionObj.id === action) {
							self.action_learn(actionObj).then((newOptions) => {
								self.io.emit('bank_action_learn:result', action, newOptions)
							})
						}
					}
				}
			})

			client.on('bank_release_action_learn', function (page, bank, action) {
				var bp = self.bank_release_actions[page][bank]
				if (bp !== undefined) {
					for (var n in bp) {
						var actionObj = bp[n]
						if (actionObj !== undefined && actionObj.id === action) {
							self.action_learn(actionObj).then((newOptions) => {
								self.io.emit('bank_release_action_learn:result', action, newOptions)
							})
						}
					}
				}
			})

			client.on('action_learn_single', function (actionObj, answer) {
				if (actionObj !== undefined) {
					self.action_learn(actionObj).then((newOptions) => {
						answer(newOptions)
					})
				}
			})
		})
	})

	system.on('action_subscribe', function (action) {
		self.subscribeAction(action)
	})

	system.on('action_unsubscribe', function (action) {
		self.unsubscribeAction(action)
	})

	system.on('action_subscribe_bank', function (page, bank) {
		if (self.bank_actions[page] !== undefined && self.bank_actions[page][bank] !== undefined) {
			// find all instance-ids in actions for bank
			for (var i in self.bank_actions[page][bank]) {
				self.subscribeAction(self.bank_actions[page][bank][i])
			}
		}
		if (self.bank_release_actions[page] !== undefined && self.bank_release_actions[page][bank] !== undefined) {
			// find all instance-ids in release_actions for bank
			for (var i in self.bank_release_actions[page][bank]) {
				self.subscribeAction(self.bank_release_actions[page][bank][i])
			}
		}
	})

	system.on('action_unsubscribe_bank', function (page, bank) {
		if (self.bank_actions[page] !== undefined && self.bank_actions[page][bank] !== undefined) {
			// find all instance-ids in actions for bank
			for (var i in self.bank_actions[page][bank]) {
				self.unsubscribeAction(self.bank_actions[page][bank][i])
			}
		}
		if (self.bank_release_actions[page] !== undefined && self.bank_release_actions[page][bank] !== undefined) {
			// find all instance-ids in release_actions for bank
			for (var i in self.bank_release_actions[page][bank]) {
				self.unsubscribeAction(self.bank_release_actions[page][bank][i])
			}
		}
	})

	self.system.on('bank_reset', function (page, bank) {
		system.emit('action_unsubscribe_bank', page, bank)

		if (self.bank_actions[page] === undefined) {
			self.bank_actions[page] = {}
		}
		self.bank_actions[page][bank] = []

		if (self.bank_release_actions[page] === undefined) {
			self.bank_release_actions[page] = {}
		}
		self.bank_release_actions[page][bank] = []

		debug('bank_reset()', page, bank, self.bank_actions[page][bank])

		self.system.emit('action_save')
	})

	self.system.on('instance_actions', function (id, actions) {
		const actionsBefore = self.action_definitions[id]
		self.action_definitions[id] = actions

		const patch = jsonPatch.compare(actionsBefore || {}, actions || {})
		if (patch.length > 0) {
			self.io.emit('action_instance_definitions_patch', id, patch)
		}
	})

	return self
}

action.prototype.getActionDefinition = function (instance_id, action) {
	var self = this

	if (self.action_definitions[instance_id]) {
		return self.action_definitions[instance_id][action]
	} else {
		return undefined
	}
}

action.prototype.subscribeAction = function (action) {
	var self = this

	if (action !== undefined && action.action !== undefined && action.instance !== undefined) {
		const definition = self.getActionDefinition(action.instance, action.action)
		if (definition) {
			// Run the subscribe function if needed
			if (definition.subscribe !== undefined && typeof definition.subscribe == 'function') {
				definition.subscribe(action)
			}
		}
	}
}

action.prototype.unsubscribeAction = function (action) {
	var self = this

	if (action !== undefined && action.action !== undefined && action.instance !== undefined) {
		const definition = self.getActionDefinition(action.instance, action.action)
		if (definition) {
			// Run the unsubscribe function if needed
			if (definition.unsubscribe !== undefined && typeof definition.unsubscribe == 'function') {
				definition.unsubscribe(action)
			}
		}
	}
}

action.prototype.action_learn = async function (action) {
	var self = this

	if (action !== undefined && action.action !== undefined && action.instance !== undefined) {
		let instance = null
		self.system.emit('instance_get', action.instance, function (_instance) {
			instance = _instance
		})

		const definition = self.getActionDefinition(action.instance, action.action)
		if (definition) {
			// Run the unsubscribe function if needed
			if (definition.learn !== undefined && typeof definition.learn == 'function') {
				return Promise.resolve()
					.then(async () => {
						const pNewOptions = Promise.resolve(definition.learn(_.cloneDeep(action)))
						const newOptions = await pTimeout(pNewOptions, 2000, 'timed out!')

						if (!newOptions) throw new Error('No new options')

						action.options = newOptions
						self.system.emit('action_save')

						return newOptions
					})
					.catch((e) => {
						debug('instance(' + (instance?.label || action.instance) + '): Error learning action options: ' + e.message)
						self.system.emit(
							'log',
							'instance(' + (instance?.label || action.instance) + ')',
							'warn',
							'Error learning action options: ' + e.message
						)
					})
			}
		}
	}
}

exports = module.exports = function (system) {
	return new action(system)
}
