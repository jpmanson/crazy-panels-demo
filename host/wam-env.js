// A minimal WAM 2.0 host environment (`WamEnv` and `WamGroup` in the audio worklet), written for
// this demo against the WAM 2.0 API. A host normally brings its own (the SDK's
// `initializeWamHost`); this page uses this one unless asked for the SDK's (`?env=sdk`).

/** Sets up the environment and a host group in `audioContext`'s worklet; returns [groupId, groupKey]. */
export async function initializeWamHost(audioContext, groupId = 'crazy-panels-host', groupKey = `${Math.random()}`) {
    const code = `(${setUp.toString()})(${JSON.stringify(groupId)}, ${JSON.stringify(groupKey)});`;
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    await audioContext.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    return [groupId, groupKey];
}

/** Runs in the worklet: the environment, once, and the group. */
function setUp(groupId, groupKey) {
    class WamGroup {
        constructor(id, key) {
            this.groupId = id;
            this.key = key;
            this.wams = new Map();
            /** Event connections: from → output → set of to. */
            this.links = new Map();
        }

        validate(key) {
            return key === this.key;
        }

        addWam(wam) {
            this.wams.set(wam.instanceId, wam);
        }

        removeWam(wam) {
            this.wams.delete(wam.instanceId);
            this.links.delete(wam.instanceId);
            for (const outputs of this.links.values()) {
                for (const set of outputs.values()) set.delete(wam.instanceId);
            }
        }

        connectEvents(from, to, output = 0) {
            if (!this.wams.has(from) || !this.wams.has(to)) return;
            if (!this.links.has(from)) this.links.set(from, new Map());
            const outputs = this.links.get(from);
            if (!outputs.has(output)) outputs.set(output, new Set());
            outputs.get(output).add(to);
        }

        disconnectEvents(from, to, output) {
            const outputs = this.links.get(from);
            if (!outputs) return;
            if (to === undefined) {
                this.links.delete(from);
                return;
            }
            for (const [o, set] of outputs) {
                if (output === undefined || o === output) set.delete(to);
            }
        }

        emitEvents(from, ...events) {
            const outputs = this.links.get(from.instanceId);
            if (!outputs) return;
            for (const set of outputs.values()) {
                for (const id of set) this.wams.get(id)?.scheduleEvents(...events);
            }
        }
    }

    class WamEnv {
        constructor() {
            this.apiVersion = '2.0.0-alpha.6';
            this.groups = new Map();
            this.scopes = new Map();
        }

        getModuleScope(moduleId) {
            if (!this.scopes.has(moduleId)) this.scopes.set(moduleId, {});
            return this.scopes.get(moduleId);
        }

        getGroup(id, key) {
            const group = this.groups.get(id);
            if (!group || !group.validate(key)) throw new Error(`no WAM group ${id} for that key`);
            return group;
        }

        addGroup(group) {
            if (!this.groups.has(group.groupId)) this.groups.set(group.groupId, group);
        }

        removeGroup(group) {
            this.groups.delete(group.groupId);
        }

        addWam(wam) {
            this.groups.get(wam.groupId)?.addWam(wam);
        }

        removeWam(wam) {
            this.groups.get(wam.groupId)?.removeWam(wam);
        }

        connectEvents(id, from, to, output) {
            this.groups.get(id)?.connectEvents(from, to, output);
        }

        disconnectEvents(id, from, to, output) {
            this.groups.get(id)?.disconnectEvents(from, to, output);
        }

        emitEvents(from, ...events) {
            this.groups.get(from.groupId)?.emitEvents(from, ...events);
        }
    }

    globalThis.webAudioModules ??= new WamEnv();
    globalThis.webAudioModules.addGroup(new WamGroup(groupId, groupKey));
}
