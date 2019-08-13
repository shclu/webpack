/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const resolve = require("enhanced-resolve");
const asyncLib = require("neo-async");
const AsyncQueue = require("./util/AsyncQueue");
const createHash = require("./util/createHash");
const { join, dirname } = require("./util/fs");

/** @typedef {import("./WebpackError")} WebpackError */
/** @typedef {import("./util/fs").InputFileSystem} InputFileSystem */

const resolveContext = resolve.create({
	resolveToContext: true
});

let FS_ACCURACY = 2000;

/**
 * @typedef {Object} FileSystemInfoEntry
 * @property {number} safeTime
 * @property {number} timestamp
 */

/**
 * @typedef {Object} Snapshot
 * @property {number=} startTime
 * @property {Map<string, FileSystemInfoEntry | "error">=} fileTimestamps
 * @property {Map<string, string | "error">=} fileHashes
 * @property {Map<string, FileSystemInfoEntry | "error">=} contextTimestamps
 * @property {Map<string, string | "error">=} contextHashes
 * @property {Map<string, FileSystemInfoEntry | "error">=} missingTimestamps
 * @property {Map<string, string | "error">=} managedItemInfo
 */

/* istanbul ignore next */
const applyMtime = mtime => {
	if (FS_ACCURACY > 1 && mtime % 2 !== 0) FS_ACCURACY = 1;
	else if (FS_ACCURACY > 10 && mtime % 20 !== 0) FS_ACCURACY = 10;
	else if (FS_ACCURACY > 100 && mtime % 200 !== 0) FS_ACCURACY = 100;
	else if (FS_ACCURACY > 1000 && mtime % 2000 !== 0) FS_ACCURACY = 1000;
};

const mergeMaps = (a, b) => {
	if (b.size === 0) return a;
	const map = new Map(a);
	for (const [key, value] of b) {
		map.set(key, value);
	}
	return map;
};

const getManagedItem = (managedPath, path) => {
	const remaining = path.slice(managedPath.length);
	let i = 0;
	let slashes = 2;
	loop: while (i < remaining.length) {
		switch (remaining.charCodeAt(i)) {
			case 47: // slash
			case 92: // backslash
				if (--slashes === 0) break loop;
				break;
			case 64: // @
				slashes++;
				break;
		}
		i++;
	}
	return path.slice(0, managedPath.length + i);
};

class FileSystemInfo {
	/**
	 * @param {InputFileSystem} fs file system
	 * @param {Object} options options
	 * @param {Iterable<string>=} options.managedPaths paths that are only managed by a package manager
	 */
	constructor(fs, { managedPaths = [] } = {}) {
		this.fs = fs;
		/** @type {Map<string, FileSystemInfoEntry | null>} */
		this._fileTimestamps = new Map();
		/** @type {Map<string, string>} */
		this._fileHashes = new Map();
		/** @type {Map<string, FileSystemInfoEntry | null>} */
		this._contextTimestamps = new Map();
		/** @type {Map<string, string>} */
		this._contextHashes = new Map();
		/** @type {Map<string, string>} */
		this._managedItems = new Map();
		this.fileTimestampQueue = new AsyncQueue({
			name: "file timestamp",
			parallelism: 30,
			processor: this._readFileTimestamp.bind(this)
		});
		this.fileHashQueue = new AsyncQueue({
			name: "file hash",
			parallelism: 10,
			processor: this._readFileHash.bind(this)
		});
		this.contextTimestampQueue = new AsyncQueue({
			name: "context timestamp",
			parallelism: 2,
			processor: this._readContextTimestamp.bind(this)
		});
		this.contextHashQueue = new AsyncQueue({
			name: "context hash",
			parallelism: 2,
			processor: this._readContextHash.bind(this)
		});
		this.managedItemQueue = new AsyncQueue({
			name: "managed item info",
			parallelism: 10,
			processor: this._getManagedItemInfo.bind(this)
		});
		this.managedPaths = Array.from(managedPaths);
		this.managedPathsWithSlash = this.managedPaths.map(p =>
			join(fs, p, "_").slice(0, -1)
		);
	}

	/**
	 * @param {Map<string, FileSystemInfoEntry | null>} map timestamps
	 * @returns {void}
	 */
	addFileTimestamps(map) {
		for (const [path, ts] of map) {
			this._fileTimestamps.set(path, ts);
		}
	}

	/**
	 * @param {Map<string, FileSystemInfoEntry | null>} map timestamps
	 * @returns {void}
	 */
	addContextTimestamps(map) {
		for (const [path, ts] of map) {
			this._contextTimestamps.set(path, ts);
		}
	}

	/**
	 * @param {string} path file path
	 * @param {function(WebpackError=, FileSystemInfoEntry=): void} callback callback function
	 * @returns {void}
	 */
	getFileTimestamp(path, callback) {
		const cache = this._fileTimestamps.get(path);
		if (cache !== undefined) return callback(null, cache);
		this.fileTimestampQueue.add(path, callback);
	}

	/**
	 * @param {string} path context path
	 * @param {function(WebpackError=, FileSystemInfoEntry=): void} callback callback function
	 * @returns {void}
	 */
	getContextTimestamp(path, callback) {
		const cache = this._contextTimestamps.get(path);
		if (cache !== undefined) return callback(null, cache);
		this.contextTimestampQueue.add(path, callback);
	}

	/**
	 * @param {string} path file path
	 * @param {function(WebpackError=, string=): void} callback callback function
	 * @returns {void}
	 */
	getFileHash(path, callback) {
		const cache = this._fileHashes.get(path);
		if (cache !== undefined) return callback(null, cache);
		this.fileHashQueue.add(path, callback);
	}

	/**
	 * @param {string} path context path
	 * @param {function(WebpackError=, string=): void} callback callback function
	 * @returns {void}
	 */
	getContextHash(path, callback) {
		const cache = this._contextHashes.get(path);
		if (cache !== undefined) return callback(null, cache);
		this.contextHashQueue.add(path, callback);
	}

	resolveBuildDependencies(context, deps, callback) {
		const files = new Set();
		const directories = new Set();
		const missing = new Set();
		const queue = asyncLib.queue(({ type, context, path }, callback) => {
			switch (type) {
				case "resolve": {
					const isDirectory = /[\\/]$/.test(path);
					const isDeps = /^deps:/.test(path);
					if (isDeps) path = path.slice(5);
					if (isDirectory) {
						resolveContext(
							context,
							path.replace(/[\\/]$/, ""),
							(err, result) => {
								if (err) return callback(err);
								queue.push({
									type: isDeps ? "directory-dependencies" : "directory",
									path: result
								});
								callback();
							}
						);
					} else {
						resolve(context, path, (err, result) => {
							if (err) return callback(err);
							queue.push({
								type: isDeps ? "file-dependencies" : "file",
								path: result
							});
							callback();
						});
					}
					break;
				}
				case "resolve-directory": {
					resolveContext(context, path, (err, result) => {
						if (err) return callback(err);
						queue.push({
							type: "directory",
							path: result
						});
						callback();
					});
					break;
				}
				case "file": {
					if (files.has(path)) {
						callback();
						break;
					}
					this.fs.realpath(path, (err, realPath) => {
						if (err) return callback(err);
						if (!files.has(realPath)) {
							files.add(realPath);
							queue.push({
								type: "file-dependencies",
								path: realPath
							});
						}
						callback();
					});
					break;
				}
				case "directory": {
					if (directories.has(path)) {
						callback();
						break;
					}
					this.fs.realpath(path, (err, realPath) => {
						if (err) return callback(err);
						if (!directories.has(realPath)) {
							directories.add(realPath);
							queue.push({
								type: "directory-dependencies",
								path: realPath
							});
						}
						callback();
					});
					break;
				}
				case "file-dependencies": {
					const module = require.cache[path];
					if (module && Array.isArray(module.children)) {
						for (const child of module.children) {
							if (child.path) {
								queue.push({
									type: "file",
									path: child.id
								});
							}
						}
					} else {
						// Unable to get dependencies from module system
						// This may be because of an incomplete require.cache implementation like in jest
						// Assume requires stay in directory and add the whole directory
						const directory = dirname(this.fs, path);
						queue.push({
							type: "directory",
							path: directory
						});
					}
					callback();
					break;
				}
				case "directory-dependencies": {
					const match = /(^.+[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)/.exec(
						path
					);
					const packagePath = match ? match[1] : path;
					const packageJson = join(this.fs, packagePath, "package.json");
					this.fs.readFile(packageJson, (err, content) => {
						if (err) {
							if (err.code === "ENOENT") {
								const parent = dirname(this.fs, packagePath);
								if (parent !== packagePath) {
									queue.push({
										type: "directory-dependencies",
										path: parent
									});
								}
								callback();
								return;
							}
							return callback(err);
						}
						let packageData;
						try {
							packageData = JSON.parse(content.toString("utf-8"));
						} catch (e) {
							return callback(e);
						}
						const depsObject = packageData.dependencies;
						if (typeof depsObject === "object" && depsObject) {
							for (const dep of Object.keys(depsObject)) {
								queue.push({
									type: "resolve-directory",
									context: packagePath,
									path: dep
								});
							}
						}
						callback();
					});
					break;
				}
			}
		}, 50);
		queue.drain = () => {
			callback(null, { files, directories, missing });
		};
		queue.error = err => {
			callback(err);
			callback = () => {};
		};
		for (const dep of deps) {
			queue.push({
				type: "resolve",
				context,
				path: dep
			});
		}
	}

	/**
	 *
	 * @param {number} startTime when processing the files has started
	 * @param {Iterable<string>} files all files
	 * @param {Iterable<string>} directories all directories
	 * @param {Iterable<string>} missing all missing files or directories
	 * @param {Object} options options object (for future extensions)
	 * @param {function(WebpackError=, Snapshot=): void} callback callback function
	 * @returns {void}
	 */
	createSnapshot(startTime, files, directories, missing, options, callback) {
		/** @type {Map<string, FileSystemInfoEntry | "error">} */
		const fileTimestamps = new Map();
		/** @type {Map<string, string | "error">} */
		const fileHashes = new Map();
		/** @type {Map<string, FileSystemInfoEntry | "error">} */
		const contextTimestamps = new Map();
		/** @type {Map<string, string | "error">} */
		const contextHashes = new Map();
		/** @type {Map<string, FileSystemInfoEntry | "error">} */
		const missingTimestamps = new Map();
		/** @type {Map<string, string | "error">} */
		const managedItemInfo = new Map();

		const managedItems = new Set();

		let jobs = 1;
		const jobDone = () => {
			if (--jobs === 0) {
				const snapshot = {};
				if (startTime) snapshot.startTime = startTime;
				if (fileTimestamps.size !== 0) snapshot.fileTimestamps = fileTimestamps;
				if (fileHashes.size !== 0) snapshot.fileHashes = fileHashes;
				if (contextTimestamps.size !== 0)
					snapshot.contextTimestamps = contextTimestamps;
				if (contextHashes.size !== 0) snapshot.contextHashes = contextHashes;
				if (missingTimestamps.size !== 0)
					snapshot.missingTimestamps = missingTimestamps;
				if (managedItemInfo.size !== 0)
					snapshot.managedItemInfo = managedItemInfo;
				callback(null, snapshot);
			}
		};
		if (files) {
			if (options && options.hash) {
				files: for (const path of files) {
					for (const managedPath of this.managedPathsWithSlash) {
						if (path.startsWith(managedPath)) {
							managedItems.add(getManagedItem(managedPath, path));
							continue files;
						}
					}
					const cache = this._fileHashes.get(path);
					if (cache !== undefined) {
						fileHashes.set(path, cache);
					} else {
						jobs++;
						this.fileHashQueue.add(path, (err, entry) => {
							if (err) {
								fileHashes.set(path, "error");
							} else {
								fileHashes.set(path, entry);
							}
							jobDone();
						});
					}
				}
			} else {
				files: for (const path of files) {
					for (const managedPath of this.managedPathsWithSlash) {
						if (path.startsWith(managedPath)) {
							managedItems.add(getManagedItem(managedPath, path));
							continue files;
						}
					}
					const cache = this._fileTimestamps.get(path);
					if (cache !== undefined) {
						fileTimestamps.set(path, cache);
					} else {
						jobs++;
						this.fileTimestampQueue.add(path, (err, entry) => {
							if (err) {
								fileTimestamps.set(path, "error");
							} else {
								fileTimestamps.set(path, entry);
							}
							jobDone();
						});
					}
				}
			}
		}
		if (directories) {
			if (options && options.hash) {
				directories: for (const path of directories) {
					for (const managedPath of this.managedPathsWithSlash) {
						if (path.startsWith(managedPath)) {
							managedItems.add(getManagedItem(managedPath, path));
							continue directories;
						}
					}
					const cache = this._contextHashes.get(path);
					if (cache !== undefined) {
						contextHashes.set(path, cache);
					} else {
						jobs++;
						this.contextHashQueue.add(path, (err, entry) => {
							if (err) {
								contextHashes.set(path, "error");
							} else {
								contextHashes.set(path, entry);
							}
							jobDone();
						});
					}
				}
			} else {
				directories: for (const path of directories) {
					for (const managedPath of this.managedPathsWithSlash) {
						if (path.startsWith(managedPath)) {
							managedItems.add(getManagedItem(managedPath, path));
							continue directories;
						}
					}
					contextTimestamps.set(path, "error");
					// TODO: getContextTimestamp is not implemented yet
				}
			}
		}
		if (missing) {
			missing: for (const path of missing) {
				for (const managedPath of this.managedPathsWithSlash) {
					if (path.startsWith(managedPath)) {
						managedItems.add(getManagedItem(managedPath, path));
						continue missing;
					}
				}
				const cache = this._fileTimestamps.get(path);
				if (cache !== undefined) {
					missingTimestamps.set(path, cache);
				} else {
					jobs++;
					this.fileTimestampQueue.add(path, (err, entry) => {
						if (err) {
							missingTimestamps.set(path, "error");
						} else {
							missingTimestamps.set(path, entry);
						}
						jobDone();
					});
				}
			}
		}
		for (const path of managedItems) {
			const cache = this._managedItems.get(path);
			if (cache !== undefined) {
				managedItemInfo.set(path, cache);
			} else {
				jobs++;
				this.managedItemQueue.add(path, (err, entry) => {
					if (err) {
						managedItemInfo.set(path, "error");
					} else {
						managedItemInfo.set(path, entry);
					}
					jobDone();
				});
			}
		}
		jobDone();
	}

	/**
	 * @param {Snapshot} snapshot1 a snapshot
	 * @param {Snapshot} snapshot2 a snapshot
	 * @returns {Snapshot} merged snapshot
	 */
	mergeSnapshots(snapshot1, snapshot2) {
		/** @type {Snapshot} */
		const snapshot = {};
		if (snapshot1.startTime && snapshot2.startTime)
			snapshot.startTime = Math.min(snapshot1.startTime, snapshot2.startTime);
		else if (snapshot2.startTime) snapshot.startTime = snapshot2.startTime;
		else if (snapshot1.startTime) snapshot.startTime = snapshot1.startTime;
		if (snapshot1.fileTimestamps || snapshot2.fileTimestamps) {
			snapshot.fileTimestamps = mergeMaps(
				snapshot1.fileTimestamps,
				snapshot2.fileTimestamps
			);
		}
		if (snapshot1.fileHashes || snapshot2.fileHashes) {
			snapshot.fileHashes = mergeMaps(
				snapshot1.fileHashes,
				snapshot2.fileHashes
			);
		}
		if (snapshot1.contextTimestamps || snapshot2.contextTimestamps) {
			snapshot.contextTimestamps = mergeMaps(
				snapshot1.contextTimestamps,
				snapshot2.contextTimestamps
			);
		}
		if (snapshot1.contextHashes || snapshot2.contextHashes) {
			snapshot.contextHashes = mergeMaps(
				snapshot1.contextHashes,
				snapshot2.contextHashes
			);
		}
		if (snapshot1.missingTimestamps || snapshot2.missingTimestamps) {
			snapshot.missingTimestamps = mergeMaps(
				snapshot1.missingTimestamps,
				snapshot2.missingTimestamps
			);
		}
		if (snapshot1.managedItemInfo || snapshot2.managedItemInfo) {
			snapshot.managedItemInfo = mergeMaps(
				snapshot1.managedItemInfo,
				snapshot2.managedItemInfo
			);
		}
		return snapshot;
	}

	/**
	 * @param {Snapshot} snapshot the snapshot made
	 * @param {function(WebpackError=, boolean=): void} callback callback function
	 * @returns {void}
	 */
	checkSnapshotValid(snapshot, callback) {
		const {
			startTime,
			fileTimestamps,
			fileHashes,
			contextTimestamps,
			contextHashes,
			missingTimestamps
		} = snapshot;
		let jobs = 1;
		const jobDone = () => {
			if (--jobs === 0) {
				callback(null, true);
			}
		};
		const invalid = () => {
			if (jobs > 0) {
				jobs = NaN;
				callback(null, false);
			}
		};
		const checkHash = (current, snap) => {
			if (snap === "error") {
				// If there was an error while snapshotting (i. e. EBUSY)
				// we can't compare further data and assume it's invalid
				return false;
			}
			return current === snap;
		};
		/**
		 * @param {FileSystemInfoEntry} current current entry
		 * @param {FileSystemInfoEntry | "error"} snap entry from snapshot
		 * @returns {boolean} true, if ok
		 */
		const checkExistance = (current, snap) => {
			if (snap === "error") {
				// If there was an error while snapshotting (i. e. EBUSY)
				// we can't compare further data and assume it's invalid
				return false;
			}
			return !current === !snap;
		};
		/**
		 * @param {FileSystemInfoEntry} current current entry
		 * @param {FileSystemInfoEntry | "error"} snap entry from snapshot
		 * @returns {boolean} true, if ok
		 */
		const checkFile = (current, snap) => {
			if (snap === "error") {
				// If there was an error while snapshotting (i. e. EBUSY)
				// we can't compare further data and assume it's invalid
				return false;
			}
			if (current && current.safeTime > startTime) {
				// If a change happened after starting reading the item
				// this may no longer be valid
				return false;
			}
			if (!current !== !snap) {
				// If existance of item differs
				// it's invalid
				return false;
			}
			if (current) {
				// For existing items only
				if (
					snap.timestamp !== undefined &&
					current.timestamp !== snap.timestamp
				) {
					// If we have a timestamp (it was a file or symlink) and it differs from current timestamp
					// it's invalid
					return false;
				}
			}
			return true;
		};
		if (fileTimestamps) {
			for (const [path, ts] of fileTimestamps) {
				const cache = this._fileTimestamps.get(path);
				if (cache !== undefined) {
					if (!checkFile(cache, ts)) {
						invalid();
					}
				} else {
					jobs++;
					this.fileTimestampQueue.add(path, (err, entry) => {
						if (err) return invalid();
						if (!checkFile(entry, ts)) {
							invalid();
						} else {
							jobDone();
						}
					});
				}
			}
		}
		if (fileHashes) {
			for (const [path, hash] of fileHashes) {
				const cache = this._fileHashes.get(path);
				if (cache !== undefined) {
					if (!checkHash(cache, hash)) {
						invalid();
					}
				} else {
					jobs++;
					this.fileHashQueue.add(path, (err, entry) => {
						if (err) return invalid();
						if (!checkHash(entry, hash)) {
							invalid();
						} else {
							jobDone();
						}
					});
				}
			}
		}
		if (contextTimestamps && contextTimestamps.size > 0) {
			// TODO: getContextTimestamp is not implemented yet
			invalid();
		}
		if (contextHashes) {
			for (const [path, hash] of contextHashes) {
				const cache = this._contextHashes.get(path);
				if (cache !== undefined) {
					if (!checkHash(cache, hash)) {
						invalid();
					}
				} else {
					jobs++;
					this.contextHashQueue.add(path, (err, entry) => {
						if (err) return invalid();
						if (!checkHash(entry, hash)) {
							invalid();
						} else {
							jobDone();
						}
					});
				}
			}
		}
		if (missingTimestamps) {
			for (const [path, ts] of missingTimestamps) {
				const cache = this._fileTimestamps.get(path);
				if (cache !== undefined) {
					if (!checkExistance(cache, ts)) {
						invalid();
					}
				} else {
					jobs++;
					this.fileTimestampQueue.add(path, (err, entry) => {
						if (err) return invalid();
						if (!checkExistance(entry, ts)) {
							invalid();
						} else {
							jobDone();
						}
					});
				}
			}
		}
		jobDone();
	}

	_readFileTimestamp(path, callback) {
		this.fs.stat(path, (err, stat) => {
			if (err) {
				if (err.code === "ENOENT") {
					this._fileTimestamps.set(path, null);
					return callback(null, null);
				}
				return callback(err);
			}

			const mtime = +stat.mtime;

			if (mtime) applyMtime(mtime);

			const ts = {
				safeTime: mtime ? mtime + FS_ACCURACY : Infinity,
				timestamp: stat.isDirectory() ? undefined : mtime
			};

			this._fileTimestamps.set(path, ts);

			callback(null, ts);
		});
	}

	_readFileHash(path, callback) {
		this.fs.readFile(path, (err, content) => {
			if (err) {
				if (err.code === "ENOENT") {
					this._fileHashes.set(path, null);
					return callback(null, null);
				}
				return callback(err);
			}

			const hash = createHash("md4");

			hash.update(content);

			const digest = /** @type {string} */ (hash.digest("hex"));

			this._fileHashes.set(path, digest);

			callback(null, digest);
		});
	}

	_readContextTimestamp(path, callback) {
		// TODO read whole folder
		this._contextTimestamps.set(path, null);
		callback(null, null);
	}

	_readContextHash(path, callback) {
		this.fs.readdir(path, (err, files) => {
			if (err) {
				if (err.code === "ENOENT") {
					this._contextHashes.set(path, null);
					return callback(null, null);
				}
				return callback(err);
			}
			files = files
				.map(file => file.normalize("NFC"))
				.filter(file => !/^\./.test(file))
				.sort();
			asyncLib.map(
				files,
				(file, callback) => {
					const child = join(this.fs, path, file);
					this.fs.stat(child, (err, stat) => {
						if (err) return callback(err);

						if (stat.isFile()) {
							return this.getFileHash(child, callback);
						}
						if (stat.isDirectory()) {
							this.contextHashQueue.increaseParallelism();
							this.getContextHash(child, (err, hash) => {
								this.contextHashQueue.decreaseParallelism();
								callback(err, hash || "");
							});
							return;
						}
						callback(null, "");
					});
				},
				(err, fileHashes) => {
					const hash = createHash("md4");

					for (const file of files) hash.update(file);
					for (const h of fileHashes) hash.update(h);

					const digest = /** @type {string} */ (hash.digest("hex"));

					this._contextHashes.set(path, digest);

					callback(null, digest);
				}
			);
		});
	}

	_getManagedItemInfo(path, callback) {
		const packageJsonPath = join(this.fs, path, "package.json");
		this.fs.readFile(packageJsonPath, (err, content) => {
			if (err) return callback(err);
			let data;
			try {
				data = JSON.parse(content.toString("utf-8"));
			} catch (e) {
				return callback(e);
			}
			const info = `${data.name || ""}@${data.version || ""}`;
			callback(null, info);
		});
	}

	getDeprecatedFileTimestamps() {
		const map = new Map();
		for (const [path, info] of this._fileTimestamps) {
			if (info) map.set(path, info.safeTime);
		}
		return map;
	}

	getDeprecatedContextTimestamps() {
		const map = new Map();
		for (const [path, info] of this._contextTimestamps) {
			if (info) map.set(path, info.safeTime);
		}
		return map;
	}
}

module.exports = FileSystemInfo;
