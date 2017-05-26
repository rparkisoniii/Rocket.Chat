/* globals UploadFS */

import fs from 'fs';
import mime from 'mime-type/with-db';
import Future from 'fibers/future';

Object.assign(FileUpload, {
	handlers: {},

	configureUploadsStore(store, name, options) {
		const type = name.split(':').pop();
		const stores = UploadFS.getStores();
		delete stores[name];

		return new UploadFS.store[store](Object.assign({
			name
		}, options, FileUpload[`default${ type }`]));
	},

	get defaultUploads() {
		return {
			collection: RocketChat.models.Uploads.model,
			filter: new UploadFS.Filter({
				onCheck: FileUpload.validateFileUpload
			}),
			// transformWrite: FileUpload.uploadsTransformWrite
			onValidate: FileUpload.uploadsOnValidate
		};
	},

	get defaultAvatars() {
		return {
			collection: RocketChat.models.Avatars.model,
			// filter: new UploadFS.Filter({
			// 	onCheck: FileUpload.validateFileUpload
			// }),
			// transformWrite: FileUpload.avatarTransformWrite,
			onValidate: FileUpload.avatarsOnValidate,
			onFinishUpload: FileUpload.avatarsOnFinishUpload
		};
	},

	avatarTransformWrite(readStream, writeStream/*, fileId, file*/) {
		if (RocketChatFile.enabled === false || RocketChat.settings.get('Accounts_AvatarResize') !== true) {
			return readStream.pipe(writeStream);
		}
		const height = RocketChat.settings.get('Accounts_AvatarSize');
		const width = height;
		return RocketChatFile.gm(readStream).background('#ffffff').resize(width, `${ height }^`).gravity('Center').crop(width, height).extent(width, height).stream('jpeg').pipe(writeStream);
	},

	avatarsOnValidate(file) {
		if (RocketChatFile.enabled === false || RocketChat.settings.get('Accounts_AvatarResize') !== true) {
			return;
		}

		const tmpFile = UploadFS.getTempFilePath(file._id);

		const fut = new Future();

		const height = RocketChat.settings.get('Accounts_AvatarSize');
		const width = height;

		RocketChatFile.gm(tmpFile).background('#ffffff').resize(width, `${ height }^`).gravity('Center').crop(width, height).extent(width, height).setFormat('jpeg').write(tmpFile, Meteor.bindEnvironment((err) => {
			if (err != null) {
				console.error(err);
			}

			const size = fs.lstatSync(tmpFile).size;
			this.getCollection().direct.update({_id: file._id}, {$set: {size}});
			fut.return();
		}));

		return fut.wait();
	},

	uploadsTransformWrite(readStream, writeStream, fileId, file) {
		if (RocketChatFile.enabled === false || !/^image\/.+/.test(file.type)) {
			return readStream.pipe(writeStream);
		}

		let stream = undefined;

		const identify = function(err, data) {
			if (err) {
				return stream.pipe(writeStream);
			}

			file.identify = {
				format: data.format,
				size: data.size
			};

			if (data.Orientation && !['', 'Unknown', 'Undefined'].includes(data.Orientation)) {
				RocketChatFile.gm(stream).autoOrient().stream().pipe(writeStream);
			} else {
				stream.pipe(writeStream);
			}
		};

		stream = RocketChatFile.gm(readStream).identify(identify).stream();
	},

	uploadsOnValidate(file) {
		if (RocketChatFile.enabled === false || !/^image\/((x-windows-)?bmp|p?jpeg|png)$/.test(file.type)) {
			return;
		}

		const tmpFile = UploadFS.getTempFilePath(file._id);

		const fut = new Future();

		const identify = Meteor.bindEnvironment((err, data) => {
			if (err != null) {
				console.error(err);
				return fut.return();
			}

			file.identify = {
				format: data.format,
				size: data.size
			};

			if ([null, undefined, '', 'Unknown', 'Undefined'].includes(data.Orientation)) {
				return fut.return();
			}

			RocketChatFile.gm(tmpFile).autoOrient().write(tmpFile, Meteor.bindEnvironment((err) => {
				if (err != null) {
					console.error(err);
				}

				const size = fs.lstatSync(tmpFile).size;
				this.getCollection().direct.update({_id: file._id}, {$set: {size}});
				fut.return();
			}));
		});

		RocketChatFile.gm(tmpFile).identify(identify);

		return fut.wait();
	},

	avatarsOnFinishUpload(file) {
		// update file record to match user's username
		const user = RocketChat.models.Users.findOneById(file.userId);
		const oldAvatar = RocketChat.models.Avatars.findOneByName(user.username);
		if (oldAvatar) {
			this.delete(oldAvatar._id);
			RocketChat.models.Avatars.deleteFile(oldAvatar._id);
		}
		RocketChat.models.Avatars.updateFileNameById(file._id, user.username);
		// console.log('upload finished ->', file);
	},

	addExtensionTo(file) {
		if (mime.lookup(file.name) === file.type) {
			return file;
		}

		const ext = mime.extension(file.type);
		if (ext && false === new RegExp(`\.${ ext }$`, 'i').test(file.name)) {
			file.name = `${ file.name }.${ ext }`;
		}

		return file;
	},

	getStore(modelName) {
		const storageType = RocketChat.settings.get('FileUpload_Storage_Type');
		const handlerName = `${ storageType }:${ modelName }`;

		if (this.handlers[handlerName] == null) {
			console.error(`Upload handler "${ handlerName }" does not exists`);
		}

		return this.handlers[handlerName];
	},

	get(file, req, res, next) {
		if (file.store && this.handlers && this.handlers[file.store] && this.handlers[file.store].get) {
			this.handlers[file.store].get(file, req, res, next);
		} else {
			res.writeHead(404);
			res.end();
			return;
		}
	}
});


export class FileUploadClass {
	constructor({ name, model, store, get, insert, getStore }) {
		this.name = name;
		this.model = model || this.getModelFromName();
		this._store = store || UploadFS.getStore(name);
		this.get = get;
		this.insert = insert;

		if (getStore) {
			this.getStore = getStore;
		}

		FileUpload.handlers[name] = this;
	}

	getStore() {
		return this._store;
	}

	get store() {
		return this.getStore();
	}

	set store(store) {
		this._store = store;
	}

	getModelFromName() {
		return RocketChat.models[this.name.split(':')[1]];
	}

	delete(fileId) {
		if (this.store && this.store.delete) {
			this.store.delete(fileId);
		}

		return this.model.deleteFile(fileId);
	}

	deleteById(fileId) {
		const file = this.model.findOneById(fileId);

		if (!file) {
			return;
		}

		return this.delete(file._id);
	}

	deleteByName(fileName) {
		const file = this.model.findOneByName(fileName);

		if (!file) {
			return;
		}

		return this.delete(file._id);
	}

	insert(file, stream, cb) {
		const fileId = this.store.create(file);

		this.store.write(stream, fileId, cb);
	}
}
