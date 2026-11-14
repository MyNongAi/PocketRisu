import { getDatabase } from 'src/ts/storage/database.svelte'

// The bot edit mode's "고칠 것" switches (the user's request, 2026-11-14): only
// the tools and the guide of what is being edited go into a request.
export type EditKind = 'bot' | 'module' | 'preset'
export type EditKinds = Record<EditKind, boolean>

export function editKinds(): EditKinds {
    const saved = getDatabase().nodeOnlyEditModeKinds
    const kinds = { bot: saved?.bot !== false, module: saved?.module !== false, preset: saved?.preset === true }
    return Object.values(kinds).some(Boolean) ? kinds : { bot: true, module: false, preset: false }
}

export function setEditKind(kind: EditKind, enabled: boolean): boolean {
    const next = { ...editKinds(), [kind]: enabled }
    if (!Object.values(next).some(Boolean)) return false
    getDatabase().nodeOnlyEditModeKinds = next
    return true
}

// Risu Access's own guide (client.ts upstream), word for word, cut into the
// parts each switch needs.
const intro = "Risuai Access MCP provides access to Risuai's features and tools, which is the software currently running on. Use the available tools to interact with Risuai's functionalities." + `
<About Risuai Features>
`
const botGuide = `Characters are the AI personas that Risuai users chat with. Fields:
- 'name': The name of the character.
- 'greeting': The greeting message of the character. This is the first message that the character will send when the chat starts.
- 'description': The description of the character. This is used to describe the character in the chat.
- 'replaceGlobalNote': A note used to provide instructions to AI models (but not you).
- 'alternateGreetings': An array of alternate greetings that the character can use.
- 'backgroundEmbedding': See below.

`
const moduleGuide = `Modules are independant packages of lorebooks and scripts. Fields:
- 'name': The name of the module.
- 'description': The description.
- 'regex': Array of regex scripts.
- 'trigger': Array of trigger scripts.
- 'backgroundEmbedding': See below.
- 'mcp': Optional MCP server URL.
- 'lowLevelAccess': Must be true to allow LLM or network requests in Lua scripts.
- 'customModuleToggle': User settings configuration, simply called "toggles". Format: key=label=type=options
  - Types:
    - (omit): Checkbox, '0'|'1'.
    - select: Dropdown. Index of the selected option.
    - text: Text input. User typed text.
    - group, groupEnd: Collapsible group start and end. Keyless.
    - divider. Keyless.
  - Examples:
    - booleanValue=Check Me
    - selectValue=Select Me=select=opt1,opt2,opt3
    - textValue=Type Me=text
    - =Collapsible Group=groupStart
    - =Optional Label=divider
    - ==groupEnd

`
const scriptGuide = `Regex Scripts are used to replace text in the chat based on regex patterns. Fields:
- 'type': The type of the script. One of:
  - 'editinput': Modifies the user's input text.
  - 'editoutput': Modifies the character's output text.
  - 'editprocess': Modifies the text before sending the HTTP request.
  - 'editdisplay': Modifies the text before displaying it in the chat.
  - 'edittrans': Modifies the text after translation.
- 'in': The regex pattern to match, without the leading and trailing slashes and flags. Should be a valid ECMAScript regex.
- 'out': The replacement text for the matches. It can use $1, $2, or $<name> (for named capture groups) to refer to the captured groups.
  - Note: It can accept Markdown and HTML, even <style> tags which will be prepended and deduplicated. One can use regex scripts for decoration with 'editdisplay' type. Same restriction as backgroundEmbedding applies; see below.
- 'flag': The regex flags to use. Should be valid ECMAScript regex flags, like 'g', 'i', 'm', etc. Multiple flags can also be used like 'gi' or 'gm'.
- 'ableFlag': A boolean value indicating whether the flag settings are enabled. If false, the script will use default flags of 'g'.
- 'comment': The name of the script. This is used to identify the script in the list.

Lorebooks are texts containing various information about the character with conditional activation based on chat history. Fields:
- 'alwaysActive': A boolean value indicating whether the entry is always active. If true, the entry will be included even if all of its keys are not in the chat history.
- 'key': The key that will activate this lorebook. Multiple keys can be specified separated by commas. If one of the keys is in the chat history, the entry will be included in the next prompt.
- 'content': The content of the entry.
- 'name': The name of the lorebook. Used for identifying the entry in the list.

`
const folderGuide = `Folders group characters in the character list. List them with 'risu-list-character-folders', then read a whole folder's characters or lorebooks at once. A character whose 'backupOf' is set is a backup of that character, made right before an edit; compare the two to see what changed.

`
const embeddingGuide = `backgroundEmbedding is an HTML string mainly for custom styling. It can, and mostly include <style> tags with CSS. Note that all selectors will be prefixed with '.chattext ' so they cannot escape the chat boundary - No html, body, :root access.
`
// PocketRisu: the prompt preset tools (presets.ts), built-in engine only.
const presetGuide = `
Prompt presets contain ordered prompt template items. Item types are plain, jailbreak, cot, chatML, persona, description, lorebook, postEverything, memory, authornote, chat and cache. Plain/jailbreak/cot items have text and a user, bot or system role; other types use innerFormat and role2 where supported. Inspect an item before changing it.
Preset toggles use key=label=type=options, like module toggles. {{getglobalvar::toggle_<key>}} reads a toggle value.
`

export function risuAccessInstructions(kinds: EditKinds = editKinds()): string {
    const scripts = kinds.bot || kinds.module
    return intro + (kinds.bot ? botGuide : '') + (kinds.module ? moduleGuide : '')
        + (scripts ? scriptGuide : '') + (kinds.bot ? folderGuide : '')
        + (scripts ? embeddingGuide : '') + (kinds.preset ? presetGuide : '')
}
