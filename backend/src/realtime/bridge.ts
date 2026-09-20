import type { RoomManager } from "./roomManager.js";

let roomManager: RoomManager | null = null;

export function setRoomManager(manager: RoomManager) {
  roomManager = manager;
}

export function getRoomManager(): RoomManager {
  if (!roomManager) {
    throw new Error("Room manager is not attached yet");
  }
  return roomManager;
}
