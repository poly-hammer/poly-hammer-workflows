'use strict';

const { finish, fail } = require('./storage.cjs');

finish().catch(fail);
