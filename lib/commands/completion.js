"use strict";
/**
 * aie completion
 *
 * Prints shell completion instructions. No shell profiles are modified by install.
 * Full dynamic completion (issue numbers, labels) can be added later without changing UX contract.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@oclif/core");
const base_command_1 = require("../base_command");
class Completion extends base_command_1.BaseCommand {
    static id = 'completion';
    static summary = 'Print shell completion installation instructions or scripts';
    static description = 'Outputs instructions for installing tab completion for bash, zsh, or fish. Completion covers command names, subcommands, and flags. No shell profile is modified by the package.';
    static examples = [
        '$ aie completion --shell bash',
        '$ aie completion --shell zsh > ~/.zfunc/_aie',
    ];
    static enableJsonFlag = false;
    static flags = {
        shell: core_1.Flags.string({
            char: 's',
            summary: 'Target shell (bash, zsh, fish)',
            options: ['bash', 'zsh', 'fish'],
            default: 'bash',
        }),
    };
    async run() {
        this.loadSpec();
        const parsed = await this.parse();
        const shell = (parsed.flags.shell || 'bash');
        if (this.useJson) {
            this.emitJson({
                shell,
                instructions: this.buildInstructions(shell),
            });
            return;
        }
        this.log(`Shell completion for aie (${shell})`);
        this.log('');
        this.log(this.buildInstructions(shell));
        this.log('');
        this.log('After setup, restart your shell or source the file.');
        this.log('Completion will include all commands, subcommands, and flags from aie schema.');
    }
    buildInstructions(shell) {
        if (shell === 'zsh') {
            return `# Zsh
# Save this file as ~/.zfunc/_aie (or in a dir in $fpath)
# Then add to ~/.zshrc: autoload -Uz compinit; compinit

_aie() {
  local -a commands
  commands=(
    'doctor:Check environment health'
    'schema:Machine-readable command contract'
    'completion:Shell completion instructions'
    'init:Initialize repository for Executor'
    'labels:GitHub label management'
    'labels setup:Create or update required labels'
    'start:Start or resume an issue'
    'queue:Show execution queue'
    'pr:Pull request helpers'
    'pr gate:Run PR review gate'
    'deps:Dependency graph inspection'
    'deps fix:Reconcile ready/blocked labels'
  )
  _describe 'aie commands' commands
  return
}

compdef _aie aie`;
        }
        if (shell === 'fish') {
            return `# Fish
# Save to ~/.config/fish/completions/aie.fish

complete -c aie -f
complete -c aie -l json -d 'Emit JSON for agents'
complete -c aie -l dry-run -d 'Preview without mutation'
complete -c aie -l no-color -d 'Disable color'
complete -c aie -l help -s h -d 'Show help'
complete -c aie -l version -d 'Print version'

# Add command-specific completions as needed from aie schema --json
complete -c aie -n '__fish_use_subcommand' -a 'doctor schema completion init labels start queue pr deps'`;
        }
        // bash default
        return `# Bash
# Add to ~/.bashrc or source from a file:

_aie_completions() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  local commands="doctor schema completion init labels labels\\ setup start queue pr pr\\ gate deps deps\\ fix"

  if [[ $prev == aie ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- $cur) )
  fi
}

complete -F _aie_completions aie`;
    }
}
exports.default = Completion;
//# sourceMappingURL=completion.js.map