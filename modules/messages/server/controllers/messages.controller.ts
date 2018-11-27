'use strict';

import chalk from 'chalk';
import * as handlebars from 'handlebars';
import * as htmlToText from 'html-to-text';
import * as _ from 'lodash';
import * as mongoose from 'mongoose';
import * as nodemailer from 'nodemailer';
import * as config from '../../../../config/config';
import { CoreHelpers } from '../../../core/server/controllers/core.server.helpers';
import { CoreErrors } from '../../../core/server/controllers/errors.server.controller';
import { User } from '../../../users/server/models/user.server.model';
import { IMessageDocument } from '../interfaces/IMessageDocument';
import { IMessageTemplateDocument } from '../interfaces/IMessageTemplateDocument';
import { Message, MessageArchive, MessageTemplate } from '../models/messages.models';

export class MessagesController {
	private helpers = new CoreHelpers();
	private errorHandler = new CoreErrors();
	private smtpTransport = nodemailer.createTransport(config.mailer.options);

	// Sends messages to an array of users
	// First pre-compile templates, then loop and send
	public sendMessages = (messageCd, users, data) => {
		if (users.length === 0) {
			return;
		}
		//
		// ensure the domain is set properly
		//
		data.domain = config.app.domain ? config.app.domain : 'http://localhost:3000';
		//
		// get the template and then send
		//
		return new Promise((resolve, reject) => {
			MessageTemplate.findOne({ messageCd }).exec((err, template) => {
				//
				// compile all the templates
				//
				template.messageBody = handlebars.compile(template.messageBodyTemplate);
				template.messageShort = handlebars.compile(template.messageShortTemplate);
				template.messageTitle = handlebars.compile(template.messageTitleTemplate);
				template.emailBody = handlebars.compile(this.appendNotificationLink(template.emailBodyTemplate));
				template.emailSubject = handlebars.compile(template.emailSubjectTemplate);
				template.link = handlebars.compile(template.linkTemplate);
				template.actions.forEach(action => {
					action.linkResolver = handlebars.compile(action.linkTitleTemplate);
				});
				let promise;
				//
				// if this is a list of userids
				//
				if (mongoose.Types.ObjectId.isValid(users[0])) {
					promise = Promise.all(
						users.map(userid => {
							return this.getUser(userid).then(user => {
								return this.sendMessage(template, user, data);
							});
						})
					);
				} else {
					promise = Promise.all(
						users.map(user => {
							return this.sendMessage(template, user, data);
						})
					);
				}
				//
				// do it
				//
				promise.then(resolve, reject);
			});
		});
	};

	// If a new user has messages but has just signed up this sets those messages
	// to link to their user account
	public claimMessages = user => {
		return this.query(Message, {
			userEmail: user.email
		}).then(messages => {
			return Promise.all(
				messages.map(message => {
					message.user = user;
					return this.saveMessage(message);
				})
			);
		});
	};

	// Return a list of this users' messages
	public list = (req, res) => {
		if (!req.user) {
			return this.sendError(res, 'No user context supplied');
		}
		this.query(Message, { user: req.user._id })
			.then(this.resResults(res))
			.catch(this.resError(res));
	};

	public listarchived = (req, res) => {
		if (!req.user) {
			return this.sendError(res, 'No user context supplied');
		}
		this.query(MessageArchive, { user: req.user._id })
			.then(this.resResults(res))
			.catch(this.resError(res));
	};

	// Count the number of messages for the current user
	public mycount = (req, res) => {
		if (!req.user) {
			return this.sendError(res, 'No user context supplied');
		}
		this.count(Message, { user: req.user._id })
			.then(countResult => {
				res.status(200).json({ countResult });
			})
			.catch(this.resError(res));
	};

	public myarchivedcount = (req, res) => {
		if (!req.user) {
			return this.sendError(res, 'No user context supplied');
		}
		this.count(MessageArchive, { user: req.user._id })
			.then(this.resResults(res))
			.catch(this.resError(res));
	};

	// This gets called when the user views the message
	public viewed = (req, res) => {
		if (!req.user) {
			return this.sendError(res, 'No user context supplied');
		}
		if (req.user._id.toString() !== req.message.user.toString()) {
			return this.sendError(res, 'Not owner of message');
		}
		req.message.dateViewed = Date.now();
		this.saveMessage(req.message)
			.then(this.resResults(res))
			.catch(this.resError(res));
	};

	// This gets called when the user actions the message
	public actioned = (req, res) => {
		if (!req.user) {
			return this.sendError(res, 'No user context supplied');
		}
		if (req.user._id.toString() !== req.message.user.toString()) {
			return this.sendError(res, 'Not owner of message');
		}

		// get the local domain, port, host, protocol info
		// this gets over a potential risk by disallowing any calls to outside APIs through this
		// mechanism
		const options = this.getHostInfoFromDomain({
			path: '/api/message/handler/action/' + req.params.action + '/user/' + req.user._id + req.message.link,
			method: 'GET'
		});
		this.helpers
			.getJSON(options)
			.then(data => {
				req.message.actionTaken = req.params.action;
				req.message.dateActioned = Date.now();
				this.archiveMessage(req.message);
				return res.status(200).json(data);
			})
			.catch(data => {
				return res.status(299).send(data);
			});
	};

	// A user purposely archives a given message
	public archive = (req, res) => {
		if (!req.user) {
			return this.sendError(res, 'No user context supplied');
		}
		if (req.user._id.toString() !== req.message.user) {
			return this.sendError(res, 'Not owner of message');
		}
		this.archiveMessage(req.message)
			.then(this.resResults(res))
			.catch(this.resError(res));
	};

	// A user purposely archives a given message
	public archiveold = (req, res) => {
		if (!req.user) {
			return this.sendError(res, 'No user context supplied');
		}
		if (req.user.roles.indexOf('admin') === -1) {
			return this.sendError(res, 'Only admin can auto archive');
		}
		this.query(Message, { date2Archive: { $lte: Date.now() } })
			.then(this.archiveMessages)
			.then(this.resResults(res))
			.catch(this.resError(res));
	};

	public send = (req, res) => {
		if (req.user.roles.indexOf('admin') === -1) {
			return this.sendError(res, 'Only admin can send via REST');
		}
		req.body.users = req.body.users || [];
		req.body.data = req.body.data || {};
		exports
			.sendMessages(req.params.messagecd, req.body.users, req.body.data)
			.then(this.resResults(res))
			.catch(this.resError(res));
	};

	public emailRetry = (req, res) => {
		if (req.user.roles.indexOf('admin') === -1) {
			return this.sendError(res, 'Only admin can send via REST');
		}
		this.query(
			{
				emailSent: false,
				emailRetries: { $lt: 3 }
			},
			''
		)
			.then(messages => {
				return Promise.all(
					messages.map(message => {
						return this.sendmail(message).then(this.saveMessage);
					})
				);
			})
			.then(() => {
				return { ok: true };
			})
			.then(this.resResults(res))
			.catch(this.resError(res));
	};

	// =========================================================================
	//
	// Message Templates CRUD
	//
	// =========================================================================
	public listTemplates = (req, res) => {
		MessageTemplate.find()
			.sort({ messageCd: 1 })
			.exec()
			.then(this.resResults(res))
			.catch(this.resError(res));
	};

	public createTemplate = (req, res) => {
		const template = new MessageTemplate(req.body);
		template.save(err => {
			if (err) {
				return res.status(422).send({
					message: this.errorHandler.getErrorMessage(err)
				});
			} else {
				res.json(template);
			}
		});
	};

	public updateTemplate = (req, res) => {
		// copy over everything passed in. This will overwrite the
		// audit fields, but they get updated in the following steps
		const template = _.assign(req.template, req.body);
		//
		// save
		//
		template.save(err => {
			if (err) {
				return res.status(422).send({
					message: this.errorHandler.getErrorMessage(err)
				});
			} else {
				res.json(template);
			}
		});
	};

	public removeTemplate = (req, res) => {
		const template = req.template;
		template.remove(err => {
			if (err) {
				return res.status(422).send({
					message: this.errorHandler.getErrorMessage(err)
				});
			} else {
				res.json(template);
			}
		});
	};

	private sendError = (res, message) => {
		return res.status(400).send({ message });
	};

	private resError = res => {
		return message => {
			return this.sendError(res, message);
		};
	};

	private resResults = res => {
		return messages => {
			return res.status(200).json(messages);
		};
	};

	// Perform a query on the messages table
	private query = (table, q): Promise<[IMessageDocument]> => {
		return new Promise((resolve, reject) => {
			table
				.find(q)
				.select('-link')
				.sort({ dateSent: -1, dateExpired: 1 })
				.populate('user', 'displayName email')
				.exec((err, messages) => {
					if (err) {
						reject(this.errorHandler.getErrorMessage(err));
					} else {
						resolve(messages);
					}
				});
		});
	};

	private count = (table, q) => {
		return new Promise((resolve, reject) => {
			table.countDocuments(q, (err, c) => {
				if (err) {
					reject(this.errorHandler.getErrorMessage(err));
				} else {
					resolve(c);
				}
			});
		});
	};

	private appendNotificationLink = messagebody => {
		const link = '<a href="{{domain}}/settings/messages">Sign in to the BCDevExchange</a>';
		const m = 'To respond to this message, ' + link + ' and navigate to your messages.';
		return messagebody + '<p><br/>' + m + '<br/></p>';
	};

	// Archive a message
	private archiveMessage = message => {
		message.dateArchived = Date.now();
		const archive = new MessageArchive(message.toObject());
		return new Promise((resolve, reject) => {
			archive.save((err, amessage) => {
				if (err) {
					reject(this.errorHandler.getErrorMessage(err));
				} else {
					message.remove(messageErr => {
						if (messageErr) {
							reject(this.errorHandler.getErrorMessage(messageErr));
						} else {
							resolve({ happiness: true });
						}
					});
				}
			});
		});
	};

	private archiveMessages = messages => {
		return Promise.all(
			messages.map(message => {
				return this.archiveMessage(message);
			})
		);
	};

	// Save a message
	private saveMessage = message => {
		return new Promise((resolve, reject) => {
			message.save((err, saveResultMessage) => {
				if (err) {
					reject(this.errorHandler.getErrorMessage(err));
				} else {
					resolve(saveResultMessage);
				}
			});
		});
	};

	// Send a message through email
	private sendmail = message => {
		const opts = {
			to: message.userEmail,
			from: config.mailer.from,
			subject: message.emailSubject,
			html: message.emailBody,
			text: htmlToText.fromString(message.emailBody, { wordwrap: 130 })
		};
		const result = {
			dateSent: Date.now(),
			isOk: true,
			error: {}
		};
		return new Promise((resolve, reject) => {
			this.smtpTransport.sendMail(opts, err => {
				if (err) {
					// tslint:disable:no-console
					console.error(chalk.red('+++ Error sending email: '));
					console.error(err);
					result.error = err;
					result.isOk = false;
				}
			});
			message.emailSent = result.isOk;
			message.emailRetries = message.emailRetries + 1;
			message.emails.push(result);
			resolve(message);
		});
	};

	// Get a user from an id
	private getUser = userid => {
		return new Promise((resolve, reject) => {
			User.findById(userid, '_id firstName lastName displayName email username').exec((err, user) => {
				if (err) {
					reject(err);
				} else {
					resolve(user);
				}
			});
		});
	};

	// Gets the domain and uses the correct protocol based on configuration
	private getDomain = () => {
		let domain = '';
		if (config.secure && config.secure.ssl) {
			domain += 'https://';
		} else {
			domain += 'http://';
		}

		domain += 'localhost:3000';
		return domain;
	};

	private getHostInfoFromDomain = o => {
		const domain = this.getDomain();
		const part1 = domain.split('://');
		const part2 = part1[1].split(':');
		const protocol = part1[0];
		const host = part2[0];
		let port = protocol === 'https' ? 443 : 80;
		port = part2[1] ? Number(part2[1]) : port;
		o._protocol = protocol;
		o.host = host;
		o.port = port;
		o.url = domain + o.path;
		return o;
	};

	// Prepare a single message
	private prepareMessage = (template: IMessageTemplateDocument, data) => {
		//
		// deal with archive and current dates
		//
		const datePosted = new Date(Date.now());
		const date2Archive = new Date(datePosted);
		date2Archive.setDate(date2Archive.getDate() + template.daysToArchive);
		//
		// put them in the data as well
		//
		data.datePosted = this.helpers.formatDate(datePosted);
		data.date2Archive = this.helpers.formatDate(date2Archive);
		//
		// make the new message by applying the templates with data
		//
		const messageUser = !data.user || !data.user._id ? null : data.user;
		const message = new Message({
			messageCd: template.messageCd,
			user: messageUser,
			userEmail: data.user.email,
			datePosted: Date.now()
		});
		//
		// include the id in the data so the links can be built
		//
		data.messageid = message._id;
		//
		// run the templates
		//
		message.messageBody = template.messageBody(data);
		message.messageShort = template.messageShort(data);
		message.messageTitle = template.messageTitle(data);
		message.emailBody = template.emailBody(data);
		message.emailSubject = template.emailSubject(data);
		message.link = template.link(data);
		//
		// now run the action tempaltes
		//
		template.actions.forEach(action => {
			message.actions.push({
				actionCd: action.actionCd,
				linkTitle: action.linkResolver(data),
				isDefault: action.isDefault
			});
		});
		return message;
	};

	// Send a specific template to a specific user
	private sendMessage = (template, user, data) => {
		data.user = user;

		if (data.opportunity) {
			// eslint-disable-next-line new-cap
			data.formattedEarnings = Intl.NumberFormat('en', {
				style: 'currency',
				currency: 'USD'
			}).format(data.opportunity.earn);
			// eslint-disable-next-line new-cap
			data.formattedBudget = Intl.NumberFormat('en', {
				style: 'currency',
				currency: 'USD'
			}).format(data.opportunity.budget);
		}

		const message = this.prepareMessage(template, data);
		return this.sendmail(message)
			.then(this.saveMessage)
			.catch(err => {
				console.error(chalk.red('+++ Error saving message: '));
				console.error(err);
				return err;
			});
	};
}