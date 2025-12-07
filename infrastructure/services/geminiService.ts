import { GoogleGenAI, Chat } from "@google/genai";
import { RemoteFile } from "../../domain/models";

const getClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API Key not found");
  }
  return new GoogleGenAI({ apiKey });
};

// --- Terminal Simulator ---

export const createTerminalSession = () => {
  const ai = getClient();
  return ai.chats.create({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: `You are a simulated Linux Ubuntu 22.04 LTS terminal. 
      - The user will type commands, and you must reply ONLY with the standard stdout or stderr of that command.
      - Maintain a persistent state for the current directory (start at /home/user), created files, and environment variables throughout the session conversation.
      - If the user runs a command that produces no output (like 'cd' or 'mkdir'), return an empty string or a new line.
      - Do NOT use markdown code blocks (\`\`\`) in your response unless the command itself (like 'cat file.md') would output markdown. Just raw text.
      - If the command is invalid, simulate the exact bash error message.
      - Assume the user has sudo privileges (password is 'password').
      - Be fast and concise.`,
      temperature: 0.1, // Low temperature for deterministic terminal behavior
    },
  });
};

export const sendTerminalCommand = async (chat: Chat, command: string): Promise<string> => {
  try {
    const result = await chat.sendMessage({ message: command });
    return result.text || "";
  } catch (error) {
    console.error("Terminal Error:", error);
    return `bash: simulated_connection_error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
};

// --- SFTP Simulation ---

export const sftpListFiles = async (chat: Chat, path: string): Promise<RemoteFile[]> => {
  try {
    // We ask the AI to act as a tool and return JSON instead of raw ls output for better UI parsing
    const result = await chat.sendMessage({ 
      message: `(System Command) List the files in directory "${path}" formatted strictly as a JSON array of objects. 
      Each object must have: "name" (string), "type" ("file" or "directory"), "size" (human readable string), "lastModified" (string).
      Do not include '.' or '..'. If directory doesn't exist, return empty array. Only return JSON.` 
    });
    
    const text = result.text.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    console.error("SFTP List Error", e);
    return [];
  }
};

export const sftpReadFile = async (chat: Chat, path: string): Promise<string> => {
  try {
    const result = await chat.sendMessage({
      message: `(System Command) Output the raw text content of file "${path}". Do not use markdown blocks. If binary, say "BINARY_FILE".`
    });
    return result.text;
  } catch (e) {
    return "";
  }
};

export const sftpWriteFile = async (chat: Chat, path: string, content: string): Promise<boolean> => {
  try {
    await chat.sendMessage({
      message: `(System Command) Create/Overwrite a file at "${path}" with the following content:\n${content}\n\nConfirm with "OK".`
    });
    return true;
  } catch (e) {
    return false;
  }
};


// --- AI Assistant ---

export const generateSSHCommand = async (prompt: string): Promise<string> => {
  const ai = getClient();
  try {
    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Generate a bash/shell command for the following task: "${prompt}". 
      Respond ONLY with the code snippet, no markdown, no explanation.`,
    });
    return result.text.trim();
  } catch (error) {
    return `Error generating command: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
};

export const explainLog = async (log: string): Promise<string> => {
  const ai = getClient();
  try {
    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Explain this server log or error message briefly and suggest a fix:\n\n${log}`,
    });
    return result.text;
  } catch (error) {
    return "Could not analyze logs.";
  }
};
