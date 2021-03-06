

/**
 * @file   allsky_drv.js
 * @author Pierre Sprimont and Davide Ricci (davide.ricci82@gmail.com)
 * @date   Thu Dec 14 10:55:11 2017
 *
 * @brief  AllSky 340M Camera driver
 *
 *
 */

"use strict";

var serialport = require('serialport');    /// Camera communication,
var config     = require('./config.json'); /// Configuration file.

var allsky_this=null;

class allsky{

    constructor(options){
	var sp_options={
	    baudRate : config.camera.baudrate,  /// 115200 (, 230400, 460800),
	    autoOpen : false
	};
	var sp_dev=config.camera.device;        /// /dev/ttyUSB0

	if(options!==undefined){
	    if(options.baudrate!==undefined) sp_options.baudRate = options.baudrate;
	    if(options.dev!==undefined) sp_dev=options.dev;
	}

	this.cb={};

	this.sp=new serialport(sp_dev, sp_options);

	this.sp.on('open', this.sp_open);
	this.sp.on('close', this.sp_close);
	this.sp.on('disconnect', this.sp_disconnect);
	this.sp.on('error', this.sp_error);
	this.sp.on('data',  this.sp_data);

	this.data_listener_func=null;

	allsky_this=this;

        /// Manage if abort is called on exposure or transfer
	this.aborting=false;
	this.transfering=false;
    }

    /// Attach an event handler
    on(evt, cb){
	if(this.cb[evt]===undefined)this.cb[evt]=[];
	this.cb[evt].push(cb);
    }

    /// Signal an event
    signal(evt, data){
	var sky=this;
	if(this.cb[evt]===undefined)
	    return undefined;
	this.cb[evt].forEach(function(cb){ cb.call(sky, data); });
	return data;
    }

    /// Define event handler
    sp_open(evt){
	allsky_this.signal("open",evt);
    }

    sp_close(evt){
        allsky_this.signal("close",evt);
    }

    sp_disconnect(evt){
        allsky_this.signal("disconnect",evt);
    }

    sp_error(evt){
        allsky_this.signal("error",evt);
    }

    sp_data(evt){
	if(allsky_this.data_listener_func!==null)
	    allsky_this.data_listener_func(evt);
	allsky_this.signal("data",evt);
    }

    /// Open serialport communication
    open(){
	var sky=this;

	return new Promise(function(ok, fail){
	    if(sky.sp.isOpen==true) ok(); else {
		console.log("Opening SerialPort...");
		sky.sp.open(function(err){
		    if(err) fail(err);
		    else ok();
		});
	    }
	});
    }

    /// Close serialport communication
    close(){
	var sky=this;

	return new Promise(function(ok, fail){
	    if(sky.sp.isOpen==true){
		console.log("Closing SP....");
		sky.sp.close(function(err){
		    if(err) fail(err);
		    else ok();
		});
	    }else ok();
	});
    }

    /// Write buffer
    write(buffer){
	var sky=this;

	return new Promise(function(ok, fail){
	    sky.sp.write(buffer, function(){

		sky.sp.drain(function(err){

		    if(err){
			console.log("write FAIL!: " + err);
			fail(err);
		    }
		    else{
			ok();
		    }
		});
	    });
	});
    }

    /// Checksum buffer. Checksum is calculated by complementing the
    /// byte, clearing the most significant bit and XOR with the
    /// current checksum, going through each byte in the command.  For
    /// each individual command the checksum starts as 0.
    checksum_buf(com){
	var cs=0;
	var cl=com.length;
	for(var b=0; b<cl-1; b++){
	    var by=com.readUInt8(b);
	    var csb = ~by & 0x7F;
	    cs = cs ^ csb;
	}
	com.writeUInt8(cs,cl-1);
	return String.fromCharCode(cs);
    }

    /// Checksum
    checksum(com){
	var cs = 0;
	for(var b=0; b<com.split('').length; b++){
	    var csb = ~com[b].charCodeAt(0) & 0x7F;
            cs = cs ^ csb;
	}
	return String.fromCharCode(cs);
    }

    /// Send command
    send_command(command, arg) {
	var sky=this;

	return new Promise(function(ok, fail){
	    var cs = sky.checksum(command);

	    var cmd=command+cs;

	    function on_data(buf){
		var received_cs=buf.readUInt8(0);
		var received_data=buf.slice(1); /// cut the first element

		if(received_cs!==cs.charCodeAt(0)){  /// checksum matching
		    console.log("Checksum ERR ! sent = " + cs.charCodeAt(0) + " received=" + received_cs );
		}else{
		    // ok(received_data);
		}
		    ok(received_data);
	    } /// on_data

	    if(arg===undefined)
		sky.data_listener_func=on_data;
	    else{
		if(arg!==null){
		    if(typeof arg === "function"){
			sky.data_listener_func=arg;
			ok();
		    }
		    else
			sky.get_bytes(arg,on_data);
		}else ok();
	    }

	    sky.write(cmd).then(function(){

	    }).catch(fail);

	});
    }

    /// Send test
    async send_test(){
	var data = await this.send_command('E',2);
	console.log("Got test answer !");
	if(data=='O'){
	    return "Test passed.";
	}
	else{
	    console.log("Test didn't passed! Answer should be 'O', received data : " + data);
	    throw "Test didn't passed! Answer should be 'O', received data : " + data;
	}
    }

    /// Get firmware version
    async get_firmware_version(){
	var data = await this.send_command('V',3);
	return data.readInt16LE(0);
    }

    /// Get serial number
    async get_serial_number(){
	var data=await this.send_command('r',11);
	return data.toString('ascii');
    }

    /// Switch on and off heater and chop.
    heater_on(){ return this.send_command('g\x01'); }
    heater_off(){ return this.send_command('g\x00'); }
    chop_on(){ return this.send_command('U\x01'); }
    chop_off(){ return this.send_command('U\x00'); }

    /// Abort
    abort(){
	var sky=this;

	return new Promise(function(ok, fail){
	    sky.aborting=true;

	    if(!sky.transfering){
		sky.send_command('A').then(ok).catch(fail);
	    }else ok();
	});
    }

    /// Open shutter
    open_shutter(){ /// leaves the shutter motor energized
	var sky=this;
	return new Promise(function(ok, fail){
	    sky.send_command('O').then(function(){
		console.log("Shutter open !");
		setTimeout(function(){
		    sky.send_command('K').then(ok).catch(fail);  /// DE_ENERGIZE
		},100); //1 second = 1000ms....
	    }).catch(fail);
	});
    }

    /// Close shutter
    close_shutter(){ /// leaves the shutter motor energized
	var sky=this;
	return new Promise(function(ok, fail){
	    sky.send_command('C').then(function(){
		console.log("Shutter closed !");
		setTimeout(function(){
		    sky.send_command('K').then(ok).catch(fail);  /// DE_ENERGIZE
		},100); //1 second = 1000ms....
	    }).catch(fail);
	});
    }

    /// Get data bytes
    get_bytes(nb, cb, skip){
	var nr=0,nt=0;
	var buf=new Buffer(nb);
	buf.fill(0);

	this.data_listener_func=function(data){
	    if(nt===0 && skip!==undefined){
		//console.log("Skipping checksum byte...");
		if(data.length>1){
		   // console.log("Skipping checksum byte... and we got more data " + data.length);
		    data.copy(buf,nr,1);
		    nr+=(data.length-1);
		}
	    }
	    else{
		data.copy(buf,nr);
		nr+=data.length;
	    }
	    nt+=data.length;

	    if(nr===nb){
		cb(buf);
		nr=0;
	    }

	}; /// data listener_func
    }


    /**
     * Define subframe
     *
     * This command defines the location and size of the
     * sub-frame. The maximum size of the sub- frame is 127 pixels.
     *
     * @param params
     * @param cb
     *
     * @return
     */
    define_subframe(params){
	var sky=this;

	return new Promise(function(ok, fail){
	    var x=Buffer.alloc(4);
	    x.writeInt32LE(params.x_start);
	    var y=Buffer.alloc(4);
	    y.writeInt32LE(params.y_start);
	    var s=Buffer.alloc(4);
	    s.writeInt32LE(params.size);

	    var combuf =Buffer.alloc(7);
	    combuf[0]='S'.charCodeAt(0);
	    combuf[1]=x[1];
	    combuf[2]=x[0];
	    combuf[3]=y[1];
	    combuf[4]=y[0];
	    combuf[5]=s[0];

	    var cs=sky.checksum_buf(combuf);

	    /// Data listener
	    sky.data_listener_func=function (buf){
		var received_cs=buf.readUInt8(0);
		var received_data=buf.slice(1); /// cut the first element

		if(received_cs!==cs.charCodeAt(0)){  /// checksum matching
		    console.log("Define subframe checksum error ! Sent = " + cs.charCodeAt(0) + " received=" + received_cs );
		    fail("Define subframe checksum error ! Sent = " + cs.charCodeAt(0) + " received=" + received_cs);
		}else{
		    // ok(received_data);
		}

		ok(received_data);
	    }; /// data_listener

	    sky.write(combuf).then(function(){}).catch(fail);
	});
    }

    /**
     *
     *
     * @param params
     * @param progress_callback Function to be called after each block is downloaded.
     * @param cb
     *
     * @return
     */
    get_image(params, progress_callback){

	var sky=this;
	sky.aborting=false;
	sky.transfering=false;

	return new Promise(function(ok, fail){

	    var image_type={
		dark: {imcode:0},
		light:{imcode:1},
		auto: {imcode:2}  /// Light-Dark (only binned).
	    };

	    /// Maximum size of the sub-frame: 127 pixels.
	    if(params.size == undefined) params.size=127; /// max size if not specified

	    var frame_type={/// width, height, blocks, frcode
		full:   {width:640,  height:480,  blocks:4096, frcode:0    },
		crop:   {width:512,  height:480,  blocks:4096, frcode:1    },
		binned: {width:320,  height:240,  blocks:1024, frcode:2    }, /// only auto
		custom: {width:params.size, height:params.size, blocks:params.size, frcode:255  }
	    };

	    if(params.imagetyp == 'auto') params.frametyp='binned';

	    Object.assign(params, image_type[params.imagetyp], frame_type[params.frametyp]);

	    /// Camera expsosure time works in 100µs units
	    params.exptime= parseFloat(params.exptime); /// It will be useful several times
	    //var exptime = params.exptime / 100e-6;
	    var exptime = params.exptime*10000.0;// :) 
	    if(exptime > 0x63FFFF) exptime = 0x63FFFF; /// 653.3599s

	    var blocks_expected = (params.width * params.height) / params.blocks;
	    var block_nbytes=2*params.blocks;
            
	    var start_time;

	    var exp=Buffer.alloc(4);
	    exp.writeInt32LE(exptime);  /// Here it will take the given exptime

	    var combuf =Buffer.alloc(7);

	    combuf[0]='T'.charCodeAt(0);
	    combuf[1]=exp[2];
	    combuf[2]=exp[1];
	    combuf[3]=exp[0];
	    combuf[4]=params.frcode;
	    combuf[5]=params.imcode;

	    sky.checksum_buf(combuf);

	    var com=combuf;
	    var cmd_checksum=combuf.readUInt8(6);

	    /// "E" = Exposure in progress. This is sent approximately every 160ms (not 150 as in doc).
	    var E_in_progress = 160; ///ms
	    var elapsed_time = -E_in_progress; /// So that first increment starts from 0
            var chopped_exptime = params.exptime*1000 > E_in_progress /// In ms
                    ? Math.ceil((params.exptime*1000)/E_in_progress)*E_in_progress /// Rounding
                    : E_in_progress;

	    var first_data_received=true;

	    sky.data_listener_func=function(in_data){

		if(first_data_received===true){
		    var firstchar=in_data.readUInt8(0);
		    first_data_received = false;

		    if(cmd_checksum !== firstchar){
			console.log("Image_data_func Checksum error !!");
		    }

		}
		else{
		    if(progress_callback!==undefined){
                        elapsed_time+=E_in_progress;
                        // console.log("Elapsed: "+elapsed_time+" Chopped:"+chopped_exptime+" Original"+params.exptime*1000);
			var now=new Date();
		        progress_callback({
                            which_progress: "exposure",
	    		    exposure_time : chopped_exptime,
	    		    elapsed_time  : elapsed_time,
	    		    percent       : ((elapsed_time/chopped_exptime)*100).toFixed(0),
			    percent2       : ( (now-start_time)/1000.0/params.exptime ).toFixed(0)
	    		});
                    }
		}

		if(in_data == 'D'){ /// Exposure complete

		    if(progress_callback!==undefined){
		        progress_callback({
                            which_progress: "exposure",
	    		    exposure_time : chopped_exptime,
	    		    elapsed_time  : elapsed_time,
	    		    percent       : 100,
			    percent2       : 100
	    		});
                    }
		    
		    var blocks_complete = 0;
		    var total_nbytes=blocks_expected*block_nbytes;
		    //var data=new ArrayBuffer();
		    var received_bytes=0;
		    var received_cs_bytes=0;
		    var block_bytes=0;

		    var image_data=new Buffer(total_nbytes);

		    console.log('Exposure Complete ! Transfering Image : ' + blocks_expected + " blocks to read");

		    sky.transfering=true;

		    sky.get_bytes(block_nbytes+1,function(in_data){

			var nb=in_data.byteLength;

			var cs = 0;
			for(var c=0; c<block_nbytes; c++)
			    cs = cs ^ in_data.readUInt8(c);

			in_data.copy(image_data,received_bytes,0,block_nbytes);

			var csum_in=in_data.readUInt8(block_nbytes);

			received_bytes+=block_nbytes;

			if(progress_callback!==undefined)
			    progress_callback({
                                which_progress: "transfer",
				received_bytes : received_bytes,
				total_nbytes   : total_nbytes,
				percent        : (received_bytes/total_nbytes*100).toFixed(0)
			    });

			if(received_bytes===total_nbytes){
			    sky.transfering=false;
			    sky.write('K').then(function(){ /// Checksum OK
				console.log("Received all data !");
				ok(image_data);
			    }).catch(fail);
			}else{

			    if(sky.aborting==true){
				console.log("TRANSFER: Abort detected! Sending S command to stop transfer");
				sky.transfering=false;
				sky.send_command('S',null).catch(fail).then(function(){
				    console.log("TRANSFER: Ok, transfer aborted!");
				    //sky.signal("transfer_aborted",{});
				    sky.transfering=false;
				    sky.aborting=false;
				    fail();
				}); /// ABORT transfer image

			    }else
				sky.write('K').catch(fail);  /// Checksum OK
			}
		    },1);

		    sky.send_command('X',null).catch(fail); /// transfer image

		}
	    };

	    sky.write(com).then(function(){
		start_time=new Date();
		//console.log("Comamnd TAKEIMAGE sent ok!");
	    }).catch(fail);
	});
    }

};

module.exports.allsky=allsky;
