# Requirements

- pip 26
- python 3.14
- node v26
- npm 11.*

- In VS Code: Python Extension


# Linux
## Package Installation

In the *backend* directory, run the following commands:
```sh
python3 -m venv venv
```
```sh
source venv/bin/activate && pip install -r requirements.txt
```

Then head into the *frontend* directory and run the following command:
```sh
npm install
```

## Running the application

In the root directory, add the .vscode folder and create this launch.json file:

```json
{
    "version": "0.1.0",
    "compounds": [
        {
            "name": "Run Backend + Frontend",
            "configurations": [
                "Run Server (Uvicorn)",
                "Run Frontend"
            ]
        }
    ],
    "configurations": [
        {
            "name": "Run Server (Uvicorn)",
            "type": "debugpy",
            "request": "launch",
            "module": "uvicorn",
            "args": [
                "main:app", "--reload"],
            "cwd": "${workspaceFolder}/backend",
            "env": {
                "PYTHONPATH": "${workspaceFolder}/backend"
            },
            "console": "integratedTerminal"
        },
        { 
            "name": "Run Frontend",
            "type":"node",
            "request":"launch",
            "runtimeExecutable":"npm",
            "runtimeArgs": ["run", "dev"],
            "cwd": "${workspaceFolder}/frontend",
            "console": "integratedTerminal"
        }
    ]
}
```

Then in the vscode sidebar, run the frontend and backend via the GUI. You can start the frontend and backend seperately or run them together via the "Run Backend + Frontend" Option.

Make sure you are using the right Python Interpreter (The one in the virtual environment from this project). In VS Code, press "Ctrl + Shift + P" and then type "Select Python Interpreter" in the Search Bar. Select the python interpreter located at "venv/bin/python".

 The application will then be running on http://localhost:5173/
    
# Windows            
## Package Installation 
In the *backend* directory, run the following commands:

Create virtual environment:
```sh
python -m venv venv
```
Activate virtual environment (with powershell):
```sh
#for powershell use this
.\venv\Scripts\Activate.ps1
#for command prompt this
venv\Scripts\activate.bat
```
Install dependencies:
```sh
pip install -r requirements.txt
```

## Running the application
In the root directory, add the .vscode folder and create this launch.json file:

```json
{
    "version": "0.2.0",
    "compounds": [
        {
            "name": "Run Backend + Frontend",
            "configurations": [
                "Run Server (Uvicorn)",
                "Run Frontend"
            ]
        }
    ],
    "configurations": [
        {
            "name": "Run Server (Uvicorn)",
            "type": "debugpy",
            "request": "launch",
            "module": "uvicorn",
            "args": [
                "main:app", "--reload"
            ],
            "cwd": "${workspaceFolder}/backend",
            "python": "${workspaceFolder}/backend/venv/Scripts/python.exe",
            "env": {
                "PYTHONPATH": "${workspaceFolder}/backend"
            },
            "console": "integratedTerminal"
        },
        { 
            "name": "Run Frontend",
            "type": "node",
            "request": "launch",
            "runtimeExecutable": "npm",
            "runtimeArgs": ["run", "dev"],
            "cwd": "${workspaceFolder}/frontend",
            "console": "integratedTerminal"
        }
    ]
}
```

Then in the vscode sidebar, run the frontend and backend via the GUI. You can start the frontend and backend seperately or run them together via the "Run Backend + Frontend" Option. If this fails and you get for example a *"module named uvicorn not found"* error, make sure you are using the right Python Interpreter (The one in the virtual environment from this project). In VS Code, press "Ctrl + Shift + P" and then type "Select Python Interpreter" in the Search Bar. Select the python interpreter located at "venv/Scripts/python.exe".

 The application will then be running on http://localhost:5173/

