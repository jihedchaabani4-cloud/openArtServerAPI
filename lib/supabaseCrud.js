import { supabase } from "./supabase.js";

export const updateOne = async (table, id, updates) => {
    const { data, error } = await supabase.from(table).update(updates).eq("id", id).select().single();
    if (error) throw error;
    return data;
};

export const deleteOne = async (table, id) => {
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) throw error;
    return true;
};
