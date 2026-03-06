let viewers = []
let lastFrame = null

function addViewer(ws){

    viewers.push(ws)

    if(lastFrame){
        ws.send(lastFrame)
    }

}

function updateFrame(frame){

    lastFrame = frame

    viewers.forEach(client=>{
        if(client.readyState === 1){
            client.send(frame)
        }
    })

}

module.exports = {
    addViewer,
    updateFrame
}