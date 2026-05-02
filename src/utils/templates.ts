import
{
    AgentConfig,
    FileContext,
    FolderContext,
    FunctionSignature
} from "./types/index";

export function createFolderContextTemplate(
    folderName:string,
    agentName:string,
    agentId:string
):FolderContext{
    const now = new Date().toISOString();
    return{
        purpose:"",
        assignedAgentId: agentId,
        assignedAgentName: agentName,
        summary:"",
        files:[],
        dependencies:[],
        createdAt: now,
        updatedAt: now,
        folderName,
        folderPath:"",
        responsibilities:[]
    };
}

export function createFileContextTemplate(
    fileName:string,
    agentName:string,
    agentId:string
):FileContext{
    const now = new Date().toISOString();
    return{
        fileName: fileName,
        filePath: "",
        assignedAgentId: agentId,
        assignedAgentName: agentName,
        purpose: "",
        createdAt: now,
        updatedAt: now,
        language: "",
        framework: "",
        imports: [],
        exports: [],
        functions: [],
        summary: ""
    };
}

export function createAgentConfigTemplate(
    agentName:string,
    role:string
):AgentConfig{
    const now = new Date().toISOString();
    return{
        agentId: generateId(agentName.toLowerCase()),
        agentName,
        role,
        description: "",
        folders: [],
        files: [],
        permissions: {
            canRead: true,
            canWrite: true,
            canCreateFiles: true,
            canDeleteFiles: true
        },
        createdAt: now,
        updatedAt: now
    };
}

export function createFunctionSignatureTemplate(
    functionName:string,
    linestart:number,
    lineend:number,
    type:"function" | "method" | "arrow-function" | "class-method" | "constructor",
    parameters:{
        name: string;
        type: string;
        optional?: boolean;
        description?: string;
    }[],
    description:string
):FunctionSignature{
    return{
        functionName,
        type: type,
        signature: "",
        linestart:linestart,
        lineend:lineend,
        parameters: parameters,
        returnType: "",
        description: description,
        lastUpdatedAt: new Date().toISOString()
    };
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}