'use strict';

const { prepare, fail } = require('./storage.cjs');

prepare().catch(fail);
