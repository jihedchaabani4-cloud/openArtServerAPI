export class BaseTextProvider {
    async complete({ systemPrompt, userPrompt, temperature }) { 
        throw new Error("BaseTextProvider.complete() not implemented"); 
    }
    async completeJSON({ systemPrompt, userPrompt, temperature }) { 
        throw new Error("BaseTextProvider.completeJSON() not implemented"); 
    }
}
