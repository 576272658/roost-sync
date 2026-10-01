import { Plugin } from "obsidian";

export default class RoostSyncPlugin extends Plugin {
  async onload() {
    console.info("Roost Sync loaded");
  }

  onunload() {}
}
