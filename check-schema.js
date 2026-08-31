/**
 * Kiểm tra schema database
 */

import pkg from 'pg';
const { Client } = pkg;

const connectionString = 'postgresql://neondb_owner:npg_SjkEuQNt14Of@ep-frosty-frog-aoi0agia-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

async function checkSchema() {
  const client = new Client({ connectionString });
  
  try {
    await client.connect();
    console.log('✅ Kết nối thành công!\n');
    
    // Kiểm tra bảng stations
    console.log('📊 Schema bảng STATIONS:');
    const stationsSchema = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'stations'
      ORDER BY ordinal_position
    `);
    console.table(stationsSchema.rows);
    
    // Kiểm tra bảng boats
    console.log('\n📊 Schema bảng BOATS:');
    const boatsSchema = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'boats'
      ORDER BY ordinal_position
    `);
    console.table(boatsSchema.rows);
    
    // Kiểm tra bảng trip_missions
    console.log('\n📊 Schema bảng TRIP_MISSIONS:');
    const tripsSchema = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'trip_missions'
      ORDER BY ordinal_position
    `);
    console.table(tripsSchema.rows);
    
    // Lấy sample data
    console.log('\n📊 Sample data STATIONS:');
    const sampleStations = await client.query('SELECT * FROM stations LIMIT 3');
    console.log(JSON.stringify(sampleStations.rows, null, 2));
    
  } catch (error) {
    console.error('❌ Lỗi:', error.message);
  } finally {
    await client.end();
  }
}

checkSchema();
