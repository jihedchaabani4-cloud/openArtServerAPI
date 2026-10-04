import { supabase } from "./supabase.js";
import { db } from "../src/container.js";

export const deleteOne = async (table, id) => {
    if (db?.[table]?.delete) {
        return db[table].delete(id);
    }
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) throw error;
    return true;
};
