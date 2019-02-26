'use strict';

import { NextFunction, Request, Response } from 'express';
import _ from 'lodash';
import mongoose from 'mongoose';
import CoreServerErrors from '../../../core/server/controllers/CoreServerErrors';
import CoreServerHelpers from '../../../core/server/controllers/CoreServerHelpers';
import { IUserModel, UserModel } from '../../../users/server/models/UserModel';
import { IProjectModel, ProjectModel } from '../models/ProjectModel';

class ProjectsServerController {
	public static getInstance() {
		return this.instance || (this.instance = new this());
	}

	private static instance: ProjectsServerController;

	private constructor() {
		this.getMyAdminProjects = this.getMyAdminProjects.bind(this);
		this.getSearchTerm = this.getSearchTerm.bind(this);
		this.update = this.update.bind(this);
		this.members = this.members.bind(this);
		this.listMembers = this.listMembers.bind(this);
		this.getProjectForPrograms = this.getProjectForPrograms.bind(this);
	}

	public async getMyAdminProjects(req: Request, res: Response): Promise<void> {
		try {
			const myProjects = await ProjectModel.find(this.getSearchTerm(req, {}))
				.populate('program', 'code title short logo')
				.select('code name short program')
				.exec();
			res.json(myProjects);
		} catch (error) {
			res.status(422).send({
				message: CoreServerErrors.getErrorMessage(error)
			});
		}
	}
	// -------------------------------------------------------------------------
	//
	// return a list of all project members. this means all members NOT
	// including users who have requested access and are currently waiting
	//
	// -------------------------------------------------------------------------
	public async members(project: IProjectModel): Promise<IUserModel[]> {
		return await UserModel.find({ roles: this.memberRole(project) })
			.select('isDisplayEmail username displayName updated created roles government profileImageURL email lastName firstName userTitle')
			.exec();
	}

	// -------------------------------------------------------------------------
	//
	// return a list of all users who are currently waiting to be added to the
	// project member list
	//
	// -------------------------------------------------------------------------
	public requests = (project, cb) => {
		mongoose
			.model('User')
			.find({ roles: this.requestRole(project) })
			.select('isDisplayEmail username displayName updated created roles government profileImageURL email lastName firstName userTitle')
			.exec(cb);
	};

	/**
	 * Create a Project
	 */
	// -------------------------------------------------------------------------
	//
	// create a new project. the user doing the creation will be set as the
	// administrator
	//
	// -------------------------------------------------------------------------
	public create = (req, res) => {
		const project = new ProjectModel(req.body);
		//
		// set the code, this is used for setting roles and other stuff
		//
		ProjectModel.schema.statics.findUniqueCode(project.name, null, newcode => {
			project.code = newcode;
			//
			// set the audit fields so we know who did what when
			//
			CoreServerHelpers.applyAudit(project, req.user);
			//
			// save and return
			//
			project.save(err => {
				if (err) {
					return res.status(422).send({
						message: CoreServerErrors.getErrorMessage(err)
					});
				} else {
					this.setProjectAdmin(project, req.user);
					req.user.save();
					res.json(project);
				}
			});
		});
	};

	// -------------------------------------------------------------------------
	//
	// this just takes the already queried object and pass it back
	//
	// -------------------------------------------------------------------------
	public read = (req, res) => {
		res.json(this.decorate(req.project, req.user ? req.user.roles : []));
	};

	// update the document, make sure to apply audit. We don't mess with the
	// code if they change the name as that would mean reworking all the roles
	public async update(req: Request, res: Response): Promise<void> {
		if (this.ensureAdmin(req.project, req.user, res)) {
			// copy over everything passed in. This will overwrite the
			// audit fields, but they get updated in the following step
			const project = _.assign(req.project, req.body);
			project.wasPublished = project.isPublished || project.wasPublished;

			const newProjectInfo = req.body;

			// set the audit fields so we know who did what when
			CoreServerHelpers.applyAudit(project, req.user);

			try {
				const updatedProject = await ProjectModel.findOneAndUpdate({ _id: req.project._id }, newProjectInfo, { new: true });
				res.json(this.decorate(updatedProject, req.user ? req.user.roles : []));
			} catch (error) {
				res.status(422).send({
					message: CoreServerErrors.getErrorMessage(error)
				});
			}
		}
	}

	// -------------------------------------------------------------------------
	//
	// delete the project
	//
	// -------------------------------------------------------------------------
	public delete = (req, res) => {
		if (this.ensureAdmin(req.project, req.user, res)) {
			const project = req.project;
			project.remove(err => {
				if (err) {
					return res.status(422).send({
						message: CoreServerErrors.getErrorMessage(err)
					});
				} else {
					res.json(project);
				}
			});
		}
	};

	// -------------------------------------------------------------------------
	//
	// return a list of all projects
	//
	// -------------------------------------------------------------------------
	public list = (req, res) => {
		ProjectModel.find(this.getSearchTerm(req, {}))
			.sort('activity name')
			.populate('createdBy', 'displayName')
			.populate('updatedBy', 'displayName')
			.populate('program', 'code title logo isPublished')
			.exec((err, projects) => {
				if (err) {
					return res.status(422).send({
						message: CoreServerErrors.getErrorMessage(err)
					});
				} else {
					res.json(this.decorateList(projects, req.user ? req.user.roles : []));
				}
			});
	};

	// Returns a list of members for the given project
	public async listMembers(req: Request, res: Response): Promise<void> {
		try {
			const users = await this.members(req.project);
			res.json(users);
		} catch (error) {
			res.status(422).send({
				message: CoreServerErrors.getErrorMessage(error)
			});
		}
	}

	// -------------------------------------------------------------------------
	//
	// this is the service front to the members call
	//
	// -------------------------------------------------------------------------
	public listRequests = (req, res) => {
		this.requests(req.project, (err, users) => {
			if (err) {
				return res.status(422).send({
					message: CoreServerErrors.getErrorMessage(err)
				});
			} else {
				res.json(users);
			}
		});
	};

	// -------------------------------------------------------------------------
	//
	// have the current user request access
	//
	// -------------------------------------------------------------------------
	public request = (req, res) => {
		this.setProjectRequest(req.project, req.user);
		req.user.save();
		res.json({ ok: true });
	};

	// Confirm a member as belonging to the project
	public async confirmMember(req: Request, res: Response): Promise<void> {
		const user = req.model;
		this.unsetProjectRequest(req.project, user);
		this.setProjectMember(req.project, user);
		try {
			const savedUser = await user.save();
			res.json(savedUser);
		} catch (error) {
			res.status(422).send({
				message: CoreServerErrors.getErrorMessage(error)
			});
		}
	};

	public async denyMember(req: Request, res: Response): Promise<void> {
		const user = req.model;
		this.unsetProjectRequest(req.project, user);
		this.unsetProjectMember(req.project, user);
		try {
			const savedUser = await user.save();
			res.json(savedUser);
		} catch (error) {
			res.status(422).send({
				message: CoreServerErrors.getErrorMessage(error)
			});
		}
	};

	// Get projects for a given program
	public async getProjectForPrograms(req: Request, res: Response): Promise<void> {
		try {
			const projects = await ProjectModel.find(this.getSearchTerm(req, { program: req.program._id }))
			.sort('name')
			.populate('createdBy', 'displayName')
			.populate('updatedBy', 'displayName')
			.exec();
			res.json(this.decorateList(projects, req.user ? req.user.roles : []));
		} catch (error) {
			res.status(422).send({
				message: CoreServerErrors.getErrorMessage(error)
			});
		}
	};

	// -------------------------------------------------------------------------
	//
	// new empty project
	//
	// -------------------------------------------------------------------------
	public new = (req, res) => {
		const p = new ProjectModel();
		res.json(p);
	};

	// Get a project by ID
	public async projectByID(req: Request, res: Response, next: NextFunction, id: string): Promise<void> {
		let queryObject: any;
		if (id.substr(0, 3) === 'prj') {
			queryObject = { code: id };
		} else {
			if (!mongoose.Types.ObjectId.isValid(id)) {
				res.status(400).send({
					message: 'Project is invalid'
				});
			} else {
				queryObject = { _id: id };
			}
		}

		try {
			const project = await ProjectModel.findOne(queryObject)
				.populate('createdBy', 'displayName')
				.populate('updatedBy', 'displayName')
				.populate('program', 'code title logo isPublished')
				.exec();

			if (!project) {
				res.status(404).send({
					message: 'No project with that identifier has been found'
				});
			} else {
				req.project = project;
				next();
			}
		} catch (error) {
			res.status(422).send({
				message: CoreServerErrors.getErrorMessage(error)
			});
		}
	}

	// -------------------------------------------------------------------------
	//
	// publish or unpublish whole sets of projects by program id
	//
	// -------------------------------------------------------------------------
	public rePublishProjects = programId => {
		return this.forProgram(programId).then(projects => {
			return Promise.all(
				projects.map(project => {
					project.isPublished = project.wasPublished;
					return project.save();
				})
			);
		});
	};
	public unPublishProjects = programId => {
		return this.forProgram(programId).then(projects => {
			return Promise.all(
				projects.map(project => {
					project.wasPublished = project.isPublished;
					project.isPublished = false;
					return project.save();
				})
			);
		});
	};

	// -------------------------------------------------------------------------
	//
	// set a project role on a user
	//
	// -------------------------------------------------------------------------
	private adminRole = project => {
		return project.code + '-admin';
	};

	private memberRole = project => {
		return project.code;
	};

	private requestRole = project => {
		return project.code + '-request';
	};

	private setProjectMember = (project, user) => {
		user.addRoles([this.memberRole(project)]);
	};

	private setProjectAdmin = (project, user) => {
		user.addRoles([this.memberRole(project), this.adminRole(project)]);
	};

	private setProjectRequest = (project, user) => {
		user.addRoles([this.requestRole(project)]);
	};

	private unsetProjectMember = (project, user) => {
		user.removeRoles([this.memberRole(project)]);
	};

	private unsetProjectAdmin = (project, user) => {
		user.removeRoles([this.memberRole(project), this.adminRole(project)]);
	};

	private unsetProjectRequest = (project, user) => {
		user.removeRoles([this.requestRole(project)]);
	};

	private ensureAdmin = (project, user, res) => {
		if (user.roles.indexOf(this.adminRole(project)) === -1 && user.roles.indexOf('admin') === -1) {
			res.status(422).send({
				message: 'User Not Authorized'
			});
			return false;
		} else {
			return true;
		}
	};

	private forProgram = (id): Promise<IProjectModel[]> => {
		return new Promise((resolve, reject) => {
			ProjectModel.find({ program: id })
				.exec()
				.then(resolve, reject);
		});
	};

	private getSearchTerm(req: Request, opts: any): any {
		opts = opts || {};
		const me = CoreServerHelpers.summarizeRoles(req.user && req.user.roles ? req.user.roles : null);
		if (!me.isAdmin) {
			opts.$or = [{ isPublished: true }, { code: { $in: me.projects.admin } }];
		}
		return opts;
	}

	// -------------------------------------------------------------------------
	//
	// this takes a project model, serializes it, and decorates it with what
	// relationship the user has to the project, and returns the JSON
	//
	// -------------------------------------------------------------------------
	private decorate = (projectModel, roles) => {
		const project = projectModel ? projectModel.toJSON() : {};
		project.userIs = {
			admin: roles.indexOf(this.adminRole(project)) !== -1,
			member: roles.indexOf(this.memberRole(project)) !== -1,
			request: roles.indexOf(this.requestRole(project)) !== -1,
			gov: roles.indexOf('gov') !== -1
		};
		return project;
	};
	// -------------------------------------------------------------------------
	//
	// decorate an entire list of projects
	//
	// -------------------------------------------------------------------------
	private decorateList = (projectModels, roles) => {
		return projectModels.map(projectModel => {
			return this.decorate(projectModel, roles);
		});
	};
}

export default ProjectsServerController.getInstance();
