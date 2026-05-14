"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const base_command_1 = require("../base_command");
const command_metadata_1 = require("../command_metadata");
const spec = (0, command_metadata_1.getCommandSpec)('init');
class Init extends base_command_1.NotImplementedCommand {
    static id = spec.id;
    static summary = spec.summary;
    static description = spec.description;
    static examples = spec.examples;
    static enableJsonFlag = spec.supportsJson;
}
exports.default = Init;
//# sourceMappingURL=init.js.map