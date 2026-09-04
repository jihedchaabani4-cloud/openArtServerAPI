import { supabase } from "./supabase.js";

export const deleteOne = async (table, id) => {
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) throw error;
    return true;
};
