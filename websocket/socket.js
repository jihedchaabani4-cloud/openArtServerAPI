import { Server } from "socket.io";
import { supabase } from "../lib/supabase.js";

let io;

export const initSocket = (httpServer) => {
    io = new Server(httpServer, {
        cors: {
            origin: process.env.FRONTEND_URL || "http://localhost:3000",
            methods: ["GET", "POST"],
            credentials: true,
        }
    });

    // ── Supabase Realtime Subscription ───────────────────────────
    // Listen for inserts and updates in the nodes table
    supabase
        .channel("nodes-status-updates")
        .on(
            "postgres_changes",
            {
                event: "*", // Listen for INSERT, UPDATE, DELETE
                schema: "public",
                table: "nodes"
            },
            (payload) => {
                const updatedNode = payload.new || payload.old;
                console.log(`📡 Supabase Realtime [${payload.eventType}]: Node ${updatedNode?.id}`);
                
                if (payload.eventType === "DELETE") {
                    // Handle deletion if needed
                    return;
                }

                // Emit to the specific character room
                const charRoom = `character_${updatedNode.character_id}`;
                emitNodeUpdate({
                    id: updatedNode.id,
                    character_id: updatedNode.character_id,
                    dna: updatedNode.dna,
                    image_url: updatedNode.image_url,
                    brain_prompt: updatedNode.brain_prompt, // Include brain_prompt
                    status: updatedNode.status
                }, charRoom);

                // Also emit to creation room for global monitoring
                emitNodeUpdate({
                    id: updatedNode.id,
                    character_id: updatedNode.character_id,
                    status: updatedNode.status
                }, "creation_updates");
            }
        )
        .subscribe();

    io.on("connection", (socket) => {
        console.log(`🔌 Client connected: ${socket.id}`);
        
        // ── Room Management ──
        socket.on("join_creation_room", () => {
            socket.join("creation_updates");
            console.log(`🔌 Client ${socket.id} joined creation_updates room`);
        });

        socket.on("join_character_room", (characterId) => {
            const roomName = `character_${characterId}`;
            socket.join(roomName);
            console.log(`🔌 Client ${socket.id} joined room: ${roomName}`);
        });

        socket.on("leave_character_room", (characterId) => {
            const roomName = `character_${characterId}`;
            socket.leave(roomName);
            console.log(`🔌 Client ${socket.id} left room: ${roomName}`);
        });

        socket.on("disconnect", () => {
            console.log(`🔌 Client disconnected: ${socket.id}`);
        });
    });

    return io;
};

export const getIO = () => {
    if (!io) {
        throw new Error("Socket.io not initialized!");
    }
    return io;
};

export const emitNodeUpdate = (updatedNode, roomId = null) => {
    if (io) {
        if (roomId) {
            io.to(roomId).emit("node_update", updatedNode);
        } else {
            io.emit("node_update", updatedNode);
        }
    }
};
